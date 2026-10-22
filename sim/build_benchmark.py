"""Build and freeze the benchmark: simulated couples-app experiments with known true effects.

    python -m sim.build_benchmark            # writes data/benchmark/dev.json and holdout.json

Each case is generated from its own seed: draw a control arm, draw the family's change, label it from the
exact expected rates (sim.families.truth), simulate the event log, and run the SQL templates at the
readout moment. The engine only ever sees `request`; `truth` is for scoring.
"""
from __future__ import annotations

import hashlib
import json
import math
import platform
from pathlib import Path

import duckdb
import numpy as np
import scipy
from scipy.stats import norm

from sim.events import build_events
from sim.families import (AUDITS, DATA_PROBLEM, DEV_FAMILIES, EXPECTED_CLASS, HOLDOUT_FAMILIES, MARGIN_REL,
                          METRICS, WHY, Design, design, truth)
from sim.model import calibrate
from sim.readout import counts

OUT = Path(__file__).resolve().parent.parent / "data" / "benchmark"
DAY = 86400
SPLITS = {"dev": (DEV_FAMILIES, 6, 100_000, "D"), "holdout": (HOLDOUT_FAMILIES, 8, 200_000, "H")}


def _metric(mid: str, role: str, arms: dict, d: Design) -> dict:
    label, num, den, better, den_kind = METRICS[mid]
    m = {"id": mid, "label": label, "role": role, "better": better, "den_kind": den_kind,
         "control": {"num": arms["control"][num], "den": arms["control"][den]},
         "test": {"num": arms["test"][num], "den": arms["test"][den]}}
    if role == "primary":
        m["mwe_rel"] = round(d.mwe_rel, 4)
        if d.itt_twin:
            m["itt_twin"] = d.itt_twin
    if role == "guardrail":
        m["margin_rel"] = MARGIN_REL[mid]
    return m


def build_request(cid: str, d: Design, cnt: dict, day: int) -> dict:
    arms = cnt["arms"]
    metrics = [_metric(d.primary, "primary", arms, d)]
    metrics += [_metric(g, "guardrail", arms, d) for g in d.guardrails]
    secondaries = ([d.itt_twin] if d.itt_twin else []) + [s for s in d.secondaries if s != d.itt_twin]
    metrics += [_metric(s, "secondary", arms, d) for s in secondaries]
    audits = [{"id": aid, "label": label, "threshold": thr,
               "control": {"num": arms["control"][num], "den": arms["control"][den]},
               "test": {"num": arms["test"][num], "den": arms["test"][den]}} for aid, label, num, den, thr in AUDITS]
    plabel = METRICS[d.primary][0]
    return {
        "id": cid,
        "name": d.name,
        "surface": d.surface,
        "hypothesis": (f"If we ship \"{d.name}\", {plabel} will rise by at least {d.mwe_rel:.1%} (relative), "
                       f"because {WHY[d.surface]}."),
        "unit": "installer; the invited partner inherits the installer's variant",
        "plan": {"per_arm": d.plan_n, "days": d.days, "split": 0.5, "alpha": 0.05, "power": 0.8},
        "readout": {"day": day, "enrolment_days": min(d.days, day)},
        "assigned": {v: arms[v]["assigned"] for v in ("control", "test")},
        "segments": cnt["segments"],
        "days": cnt["days"],
        "metrics": metrics,
        "audits": audits,
    }


def naive_ships(m: dict) -> bool:
    """The usual rule: the registered primary is better with p < 0.05 (pooled two-proportion z-test)."""
    xc, nc, xt, nt = m["control"]["num"], m["control"]["den"], m["test"]["num"], m["test"]["den"]
    if min(nc, nt) == 0:
        return False
    p = (xc + xt) / (nc + nt)
    se = math.sqrt(p * (1 - p) * (1 / nc + 1 / nt))
    if se == 0:
        return False
    z = (xt / nt - xc / nc) / se
    pval = 2 * norm.sf(abs(z))
    return pval < 0.05 and (z > 0) == (m["better"] == "up")


def make_case(cid: str, family: str, seed: int) -> dict:
    for attempt in range(200):
        rng = np.random.default_rng(seed + attempt)
        base, _ = calibrate(rng)
        d = design(family, base, rng)
        t = truth(base, d)
        if t["class"] != EXPECTED_CLASS[family]:
            continue
        n_total = int(rng.poisson(2 * d.plan_n * d.traffic))
        ev = build_events(rng, base, d.shift, n_total=n_total, days=d.days, start_weekday=int(rng.integers(7)),
                          split_couples=d.split_couples, srm_crash=d.srm_crash, tracking_bug=d.tracking_bug)
        if d.peek:
            day = None
            for look in range(3, d.days):
                cnt = counts(ev, look * DAY)
                prim = next(m for m in build_request(cid, d, cnt, look)["metrics"] if m["role"] == "primary")
                if naive_ships(prim):
                    day = look
                    break
            if day is None:
                continue
        else:
            day = d.days + 2
            cnt = counts(ev, day * DAY)
        req = build_request(cid, d, cnt, day)
        story = d.story
        if d.peek:
            story += (f" The team looked every day and stopped on day {day} of {d.days}, the first time the primary "
                      f"showed p < 0.05.")
        return {"id": cid, "request": req,
                "truth": {"family": family, "class": t["class"], "data_problem": family in DATA_PROBLEM,
                          "story": story, "seed": seed + attempt, "true": t}}
    raise RuntimeError(f"{cid}: no draw of {family} in 200 attempts")


def build(split: str) -> list[dict]:
    families, per, seed0, prefix = SPLITS[split]
    order = [f for f in families for _ in range(per)]
    np.random.default_rng(seed0).shuffle(order)
    cases = []
    for i, fam in enumerate(order, 1):
        cid = f"{prefix}{i:02d}"
        case = make_case(cid, fam, seed0 + i * 1000)
        cases.append(case)
        print(f"{cid} {fam:17s} {case['truth']['class']:8s} n/arm plan {case['request']['plan']['per_arm']:6d} "
              f"day {case['request']['readout']['day']}", flush=True)
    return cases


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"generator": "python -m sim.build_benchmark", "python": platform.python_version(),
            "numpy": np.__version__, "scipy": scipy.__version__, "duckdb": duckdb.__version__}
    for split in SPLITS:
        cases = build(split)
        body = json.dumps({"split": split, "meta": meta, "cases": cases}, indent=1, sort_keys=False)
        (OUT / f"{split}.json").write_text(body + "\n", encoding="utf-8")
        print(split, len(cases), "cases, sha256", hashlib.sha256(body.encode()).hexdigest()[:16])


if __name__ == "__main__":
    main()
