"""Score a benchmark run against the truth labels, with the definitions and gate in docs/PRD.md.

    node eval/run.js dev && python -m eval.score dev
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = ("engine", "naive", "naive_guard")
NAMES = {"engine": "Ship or Kill", "naive": "Naive (primary p < 0.05)",
         "naive_guard": "Naive + significant-guardrail veto"}
VERDICTS = ("roll_out", "iterate", "kill", "keep_running", "fix_data")
FAMILY_ORDER = ["clean_win", "clean_null", "clean_loss", "denominator_trap", "guardrail_loud", "srm_bug",
                "tracking_bug", "peeking", "guardrail_quiet", "split_couples", "underpowered_win"]


def load(split: str, results: Path | None = None) -> list[dict]:
    cases = {c["id"]: c for c in json.loads((ROOT / "data" / "benchmark" / f"{split}.json").read_text("utf-8"))["cases"]}
    res = json.loads((results or ROOT / "eval" / "results" / f"{split}.json").read_text("utf-8"))
    out = []
    for r in res["rows"]:
        t = cases[r["id"]]["truth"]
        out.append({**r, "family": t["family"], "cls": t["class"], "data_problem": t["data_problem"],
                    "engine": r["verdict"]})
    return out, res


def pct(x: float) -> str:
    """Percent rounded half up, as the web page shows it (Python's format rounds half to even)."""
    return f"{int(x * 100 + 0.5)}%"


def rate(num: int, den: int) -> str:
    return f"{num}/{den} ({pct(num / den)})" if den else "-"


def metrics(rows: list[dict], rule: str) -> dict:
    non_win = [r for r in rows if r["cls"] != "winner"]
    harmful = [r for r in rows if r["cls"] == "harmful"]
    winners = [r for r in rows if r["cls"] == "winner"]
    clean_winners = [r for r in winners if not r["data_problem"]]
    problems = [r for r in rows if r["data_problem"]]
    clean = [r for r in rows if not r["data_problem"]]
    return {
        "wrong_rollouts": (sum(r[rule] == "roll_out" for r in non_win), len(non_win)),
        "harmful_rollouts": (sum(r[rule] == "roll_out" for r in harmful), len(harmful)),
        "problems_caught": (sum(r[rule] == "fix_data" for r in problems), len(problems)),
        "false_alarms": (sum(r[rule] == "fix_data" for r in clean), len(clean)),
        "winners_killed": (sum(r[rule] == "kill" for r in winners), len(winners)),
        "missed_winners": (sum(r[rule] != "roll_out" for r in clean_winners), len(clean_winners)),
    }


def gate(m: dict) -> list[tuple[str, bool, str]]:
    def frac(k):
        n, d = m[k]
        return n / d if d else 0.0
    return [
        ("Wrong roll-outs ≤ 5% of non-winners", frac("wrong_rollouts") <= 0.05, rate(*m["wrong_rollouts"])),
        ("Data problems caught ≥ 90%", frac("problems_caught") >= 0.90, rate(*m["problems_caught"])),
        ("False data alarms ≤ 5% of clean cases", frac("false_alarms") <= 0.05, rate(*m["false_alarms"])),
        ("Winners killed ≤ 5% of true winners", frac("winners_killed") <= 0.05, rate(*m["winners_killed"])),
    ]


def report(split: str, results: Path | None = None) -> str:
    rows, res = load(split, results)
    lines = [f"# {split}: {len(rows)} cases, engine {res['engine_version']} ({res['engine_sha256']})", ""]
    ms = {rule: metrics(rows, rule) for rule in RULES}
    lines += ["| | " + " | ".join(NAMES[r] for r in RULES) + " |", "| --- |" + " --- |" * len(RULES)]
    for key, label in (("wrong_rollouts", "Wrong roll-outs (of non-winners)"),
                       ("harmful_rollouts", "Harmful roll-outs (of harmful)"),
                       ("problems_caught", "Data problems caught"),
                       ("false_alarms", "False data alarms (of clean cases)"),
                       ("winners_killed", "Winners killed"),
                       ("missed_winners", "Missed winners (of clean winners)")):
        lines.append(f"| {label} | " + " | ".join(rate(*ms[r][key]) for r in RULES) + " |")
    lines += ["", "## Release gate (Ship or Kill)", ""]
    g = gate(ms["engine"])
    for label, ok, val in g:
        lines.append(f"- {'PASS' if ok else 'FAIL'}: {label}: {val}")
    lines.append(f"- **Gate: {'PASSED' if all(ok for _, ok, _ in g) else 'FAILED'}**")

    nw = lambda rule: ms[rule]["wrong_rollouts"][0] / max(ms[rule]["wrong_rollouts"][1], 1)  # noqa: E731
    mw = lambda rule: ms[rule]["missed_winners"][0] / max(ms[rule]["missed_winners"][1], 1)  # noqa: E731
    lines += ["", "## Hypothesis", "",
              f"- Naive ships ≥ 20% of non-winners: {pct(nw('naive'))} → {'yes' if nw('naive') >= 0.20 else 'no'}",
              f"- Ship or Kill ships ≤ 5%: {pct(nw('engine'))} → {'yes' if nw('engine') <= 0.05 else 'no'}",
              f"- Misses ≤ 15 points more winners than naive: {pct(mw('engine'))} vs {pct(mw('naive'))} "
              f"({(mw('engine') - mw('naive')) * 100:+.0f} points) → {'yes' if mw('engine') - mw('naive') <= 0.15 else 'no'}"]

    lines += ["", "## By family", "", "| Family | Truth | n | Ship or Kill | Naive | Naive + guardrails |",
              "| --- | --- | --- | --- | --- | --- |"]
    fam = defaultdict(list)
    for r in rows:
        fam[r["family"]].append(r)
    short = {"roll_out": "roll out", "iterate": "iterate", "kill": "kill", "keep_running": "keep running",
             "fix_data": "fix data"}
    for f in FAMILY_ORDER:
        if f not in fam:
            continue
        rs = fam[f]
        cells = []
        for rule in RULES:
            c = Counter(r[rule] for r in rs)
            cells.append(", ".join(f"{short[v]} {c[v]}" for v in VERDICTS if c[v]))
        lines.append(f"| {f} | {rs[0]['cls']}{' (data)' if rs[0]['data_problem'] else ''} | {len(rs)} | " +
                     " | ".join(cells) + " |")

    wrong = [r for r in rows if (r["engine"] == "roll_out" and r["cls"] != "winner")
             or (r["engine"] == "kill" and r["cls"] == "winner")
             or (r["engine"] == "fix_data") != r["data_problem"]]
    if wrong:
        lines += ["", "## Ship or Kill errors", ""]
        for r in wrong:
            lines.append(f"- {r['id']} ({r['family']}, {r['cls']}): {r['engine']}. {r['headline']}")
    return "\n".join(lines) + "\n"


def main() -> None:
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    results = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    text = report(split, results)
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
