"""Build the data the web page loads: worked examples (two public experiments and two illustrative cases)
and the benchmark explorer (every case, its truth and the frozen run's calls).

    python -m scripts.build_site_data
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from scipy.stats import chisquare

ROOT = Path(__file__).resolve().parent.parent
SITE_DATA = ROOT / "site" / "data"


def _m(mid, label, role, better, c, t, den_kind="assigned", **extra):
    return {"id": mid, "label": label, "role": role, "better": better, "den_kind": den_kind,
            "control": {"num": c[0], "den": c[1]}, "test": {"num": t[0], "den": t[1]}, **extra}


def cookie_cats() -> dict:
    rows = list(csv.DictReader(open(ROOT / "data" / "real" / "cookie_cats.csv", encoding="utf-8")))
    arm = {"gate_30": "control", "gate_40": "test"}
    agg = {a: {"n": 0, "r1": 0, "r7": 0, "r30": 0, "zero": 0} for a in arm.values()}
    for r in rows:
        a = agg[arm[r["version"]]]
        a["n"] += 1
        a["r1"] += r["retention_1"].upper() == "TRUE"
        a["r7"] += r["retention_7"].upper() == "TRUE"
        a["r30"] += int(r["sum_gamerounds"]) >= 30
        a["zero"] += int(r["sum_gamerounds"]) == 0
    c, t = agg["control"], agg["test"]
    assert c["n"] + t["n"] == 90189
    return {
        "id": "cookie-cats",
        "kind": "public",
        "name": "Cookie Cats: first gate at level 40 instead of 30",
        "surface": "progression",
        "hypothesis": "If the first gate (a forced wait) moves from level 30 to level 40, 7-day retention will rise by "
                      "at least 2% (relative), because players get further into the game before the first block.",
        "unit": "player, assigned at install",
        "source": "Real A/B test in the mobile game Cookie Cats (Tactile Entertainment), 90,189 players, published "
                  "by Rasmus Bååth for DataCamp. No test plan was published, so this reading supplies its own "
                  "registration: primary D7 retention (minimum worthwhile effect 2% relative), guardrail D1 retention "
                  "(margin 2% relative). The call doesn't depend on those choices: D7 retention fell.",
        "extra_checks": [
            f"Players who never played a round can't have been affected by where the gate is: "
            f"{c['zero'] / c['n']:.2%} of control, {t['zero'] / t['n']:.2%} of test. A difference that size is "
            f"ordinary noise (two-proportion p = 0.17), so the arms look comparable apart from the sample ratio warning."
        ],
        "plan": {"split": 0.5, "alpha": 0.05},
        "readout": {},
        "assigned": {"control": c["n"], "test": t["n"]},
        "segments": [],
        "days": [],
        "metrics": [
            _m("d7", "D7 retention", "primary", "up", (c["r7"], c["n"]), (t["r7"], t["n"]), mwe_rel=0.02),
            _m("d1", "D1 retention", "guardrail", "up", (c["r1"], c["n"]), (t["r1"], t["n"]), margin_rel=0.02),
            _m("r30", "Played 30+ rounds in 14 days", "secondary", "up", (c["r30"], c["n"]), (t["r30"], t["n"])),
        ],
        "audits": [],
    }


def udacity() -> dict:
    def load(name):
        out = []
        for r in csv.DictReader(open(ROOT / "data" / "real" / f"udacity_screener_{name}.csv", encoding="utf-8")):
            out.append({k: (int(v) if v not in ("", None) and k != "Date" else v) for k, v in r.items()})
        return out
    ctl, exp = load("control"), load("experiment")
    days_with_outcomes = [i for i, r in enumerate(ctl) if r["Enrollments"] != ""]
    s = lambda rows, k, idx=None: sum(rows[i][k] for i in (idx if idx is not None else range(len(rows))))  # noqa: E731
    c_clicks, t_clicks = s(ctl, "Clicks", days_with_outcomes), s(exp, "Clicks", days_with_outcomes)
    c_enr, t_enr = s(ctl, "Enrollments", days_with_outcomes), s(exp, "Enrollments", days_with_outcomes)
    c_pay, t_pay = s(ctl, "Payments", days_with_outcomes), s(exp, "Payments", days_with_outcomes)
    pv = (s(ctl, "Pageviews"), s(exp, "Pageviews"))
    ck = (s(ctl, "Clicks"), s(exp, "Clicks"))
    pv_p = chisquare(list(pv)).pvalue
    ck_p = chisquare(list(ck)).pvalue
    # Udacity's practical-significance boundaries are absolute (gross conversion 1 point, net conversion 0.75
    # points). The engine takes relative ones, so convert them on the observed control rates.
    gross_c, net_c = c_enr / c_clicks, c_pay / c_clicks
    return {
        "id": "udacity-screener",
        "kind": "public",
        "name": "Udacity: free-trial screener",
        "surface": "sign-up",
        "hypothesis": "If students who click \"Start free trial\" are asked how many hours a week they can study, and "
                      "warned when it is under 5, fewer students who are likely to quit will enrol (gross conversion "
                      "falls by at least 1 point) without fewer students paying (net conversion falls by no more "
                      "than 0.75 points).",
        "unit": "cookie that clicked \"Start free trial\" (the screener appears after the click)",
        "source": "Final-project data of Udacity's A/B Testing course (by Google): daily counts per arm, 11 October "
                  "to 16 November; enrolments and payments for the first 23 days only, so the metrics use those days. "
                  "The thresholds are the course's own practical-significance boundaries. Presented by the course as "
                  "a real Udacity experiment; treat it as a teaching dataset.",
        "extra_checks": [
            f"The course's other sanity checks also pass over all 37 days: pageviews {pv[0]:,} vs {pv[1]:,} "
            f"(p = {pv_p:.2f}), clicks {ck[0]:,} vs {ck[1]:,} (p = {ck_p:.2f}).",
        ],
        "plan": {"split": 0.5, "alpha": 0.05},
        "readout": {},
        "assigned": {"control": c_clicks, "test": t_clicks},
        "segments": [],
        "days": [{"name": str(k + 1), "control": ctl[i]["Clicks"], "test": exp[i]["Clicks"]}
                 for k, i in enumerate(days_with_outcomes)],
        "metrics": [
            _m("gross", "Gross conversion (enrolments per click)", "primary", "down", (c_enr, c_clicks),
               (t_enr, t_clicks), mwe_rel=round(0.01 / gross_c, 5)),
            _m("net", "Net conversion (payments per click)", "guardrail", "up", (c_pay, c_clicks),
               (t_pay, t_clicks), margin_rel=round(0.0075 / net_c, 5)),
            _m("retention", "Payments per enrolment", "secondary", "up", (c_pay, c_enr), (t_pay, t_enr),
               den_kind="subset"),
        ],
        "audits": [],
    }


def interview_case(reading: str) -> dict:
    """The interview question, with illustrative counts built to match it: D1 retention +6%, D0 activation -4%
    at p = 0.08. Reading A: D1 is measured on activated couples. Reading B: D1 is measured per installer."""
    n = 8800
    act = (2640, 2534)                       # 30.0% vs 28.8%: -4.0% relative, p = 0.08
    common = {
        "kind": "illustrative",
        "surface": "onboarding",
        "unit": "installer; the invited partner inherits the installer's variant",
        "plan": {"per_arm": 8800, "days": 14, "split": 0.5, "alpha": 0.05},
        "readout": {"day": 16, "enrolment_days": 14},
        "assigned": {"control": n, "test": n},
        "segments": [{"name": "android", "control": 7040, "test": 7012}, {"name": "ios", "control": 1760, "test": 1788}],
        "days": [],
        "audits": [
            {"id": "shared_without_partner", "label": "Shared game with no partner joined", "threshold": 0.005,
             "control": {"num": 6, "den": n}, "test": {"num": 8, "den": n}},
            {"id": "partner_other_arm", "label": "Partner joined from the other arm", "threshold": 0.01,
             "control": {"num": 9, "den": 3100}, "test": {"num": 7, "den": 2990}},
        ],
        "source": "Illustrative counts built to match the question (not real data): 8,800 installers per arm, D0 "
                  "activation 30.0% vs 28.8% (-4%, p = 0.08). The registration (minimum worthwhile effect 5%, "
                  "activation margin -5%, uninstall and crash margins) is an assumption.",
    }
    guard = [
        _m("act", "D0 couple activation", "guardrail", "up", (act[0], n), (act[1], n), margin_rel=0.05),
        _m("un", "Uninstalls within 48 h", "guardrail", "down", (748, n), (752, n), margin_rel=0.12),
        _m("crash", "Users with a crash within 48 h", "guardrail", "down", (176, n), (174, n), margin_rel=0.5),
    ]
    if reading == "A":
        # D1 among activated: 50.0% vs 53.0% (+6%); non-activated return at 15% in both arms
        d1_act = ((1320, act[0]), (1343, act[1]))
        d1_all = ((1320 + 924, n), (1343 + 940, n))
        return {**common, "id": "interview-a", "name": "The interview question, reading A: D1 measured on activated couples",
                "hypothesis": "If couples pair before their first game, D1 retention will rise by at least 5% "
                              "(relative), because couples who start together come back together.",
                "metrics": [
                    _m("d1_act", "D1 retention of activated couples", "primary", "up", *d1_act, den_kind="subset",
                       itt_twin="d1", mwe_rel=0.05),
                    *guard,
                    _m("d1", "D1 retention", "secondary", "up", *d1_all),
                ]}
    # Reading B: D1 per installer 25.5% vs 27.0% (+6%)
    return {**common, "id": "interview-b", "name": "The interview question, reading B: D1 measured per installer",
            "hypothesis": "If couples pair before their first game, D1 retention will rise by at least 5% (relative), "
                          "because couples who start together come back together.",
            "metrics": [
                _m("d1", "D1 retention", "primary", "up", (2244, n), (2379, n), mwe_rel=0.05),
                *guard,
                _m("d1_act", "D1 retention of activated couples", "secondary", "up", (1320, act[0]), (1395, act[1]),
                   den_kind="subset"),
            ]}


def benchmark() -> dict:
    out = []
    for split in ("dev", "holdout"):
        cases = json.loads((ROOT / "data" / "benchmark" / f"{split}.json").read_text("utf-8"))["cases"]
        res = {r["id"]: r for r in json.loads((ROOT / "eval" / "results" / f"{split}.json").read_text("utf-8"))["rows"]}
        for c in cases:
            t = c["truth"]
            tr = t["true"]
            out.append({
                "id": c["id"], "split": split, "family": t["family"], "class": t["class"],
                "data_problem": t["data_problem"], "story": t["story"],
                "true_primary": {"id": tr["primary"], "improvement": tr["improvement"], "mwe_abs": tr["mwe_abs"]},
                "true_breached": tr["breached"],
                "frozen": {k: res[c["id"]][k] for k in ("verdict", "naive", "naive_guard")},
                "request": c["request"],
            })
    return {"cases": out}


def main() -> None:
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    examples = [interview_case("A"), interview_case("B"), udacity(), cookie_cats()]
    (SITE_DATA / "examples.json").write_text(json.dumps({"examples": examples}, indent=1) + "\n", encoding="utf-8",
                                             newline="\n")
    (SITE_DATA / "benchmark.json").write_text(json.dumps(benchmark(), separators=(",", ":")) + "\n",
                                              encoding="utf-8", newline="\n")
    for e in examples:
        print(e["id"], e["assigned"])
    print("benchmark.json", (SITE_DATA / "benchmark.json").stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
