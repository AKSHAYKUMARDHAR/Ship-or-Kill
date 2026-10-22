# Ship or Kill

An A/B test readout that makes the call (**roll out, iterate or kill**) and shows its working. It reads a
test the way a careful analyst would, in a fixed order:

1. It checks the data before the results.
2. It won't call a winner before the planned sample.
3. It reads the primary metric per assigned user.
4. It passes a guardrail only when the test rules out harm beyond the agreed margin.

Paste counts from PostHog, Mixpanel, SQL or a spreadsheet. Nothing leaves your browser.

**Live: https://akshaykumardhar.github.io/Ship-or-Kill/**
- a readout, with worked examples;
- a planner that sizes a test for every check;
- the benchmark explorer, with every case open to inspect.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Example test plan for a couples app (state diagrams, variant logic, edge cases):
  [docs/TEST_PLAN_EXAMPLE.md](docs/TEST_PLAN_EXAMPLE.md)
- How the benchmark was built: [data/BENCHMARK_GUIDE.md](data/BENCHMARK_GUIDE.md)
- Every run, with its errors: [eval/RUNS.md](eval/RUNS.md)

## Why

A test ends and someone has to decide. The numbers rarely agree with each other: D1 retention is up 6%, D0
activation is down 4% at p = 0.08, and the test was planned for another week. Four things go wrong
again and again:

- **Broken data looks like a result.** About 6% of Microsoft's experiments had a sample ratio mismatch
  (Fabijan et al., KDD 2019).
- **Peeking turns noise into wins.** In 1,000 A/A tests at Wish, stopping at the first p < 0.05 gave
  about 21% false positives.
- **Conditional metrics reward filtering.** Add friction to onboarding and retention "of activated users"
  rises on its own, even when fewer users are retained.
- **"Not significantly worse" is not "not worse".** A guardrail rule based on significance lets through
  any harm the test is too small to see.

GrowthBook and Statsig now recommend ship or roll back inside their platforms. Neither publishes how often
the recommendation is right, and many small teams don't use either.

## The test

**136 simulated A/B tests on a couples app, each with a known true effect,** frozen in git before any
engine code existed:

- **Built from raw events.** Each one is a PostHog-style event log (exposure, onboarding, invite, partner
  joined, shared game, opens, push disabled, crash, uninstall) with realistic event loss. The readout
  counts come from the SQL template.
- **Exact truth.** True effects come from the model, integrated exactly, not from the sample.
- **Eleven case types:**
  - clean win, null and loss;
  - the denominator trap;
  - loud guardrail harm;
  - sample ratio bug;
  - tracking bug;
  - peeking;
  - three held-out only: guardrail harm near the margin, couples split across arms, and underpowered
    winners.
- **The split:** 48 cases for development, 88 held out and run once.

**The comparison** is the rule most teams use: ship if the registered primary is up with p < 0.05. A second
baseline adds a significance veto on guardrails.

## Results

Held-out release run, engine frozen at commit e81e1d7. Each figure is cases out of the cases it applies to.

| Measure | Ship or Kill | Usual rule | Usual rule + guardrail veto |
| --- | --- | --- | --- |
| Non-winners rolled out | **0/64** | 39/64 (61%) | 19/64 (30%) |
| Harmful variants rolled out | **0/48** | 31/48 (65%) | 11/48 (23%) |
| Broken tests caught | **24/24** | 0/24 | 0/24 |
| False data alarms | 0/64 | 0/64 | 0/64 |
| Real winners killed | 0/24 | 0/24 | 0/24 |
| Real winners held back (clean data) | **7/16 (44%)** | 2/16 (12%) | 2/16 (12%) |

**The release gate passed:**
- wrong roll-outs ≤ 5%;
- data problems caught ≥ 90%;
- false alarms ≤ 5%;
- winners killed ≤ 5%.

**The hypothesis was partly wrong.** It predicted the extra caution would cost at most 15 points of true
winners. It cost 31.

What the run shows:

- **The trust checks did the most work.** All 24 broken tests were stopped:
  - SRM bugs (a crash before exposure on old Android);
  - tracking bugs (a solo game firing the shared-game event);
  - couples randomised one partner at a time.

  The usual rule would have shipped 13 of them.
- **The denominator trap fooled the usual rule 7 times in 8.** In each case, D1 retention "of activated
  couples" truly rose while D1 per installer truly fell. Reading per installer caught all 8.
- **Non-inferiority mattered where harm sat near the margin.** In a case type the engine never saw in
  development, a significance veto still shipped 3 harmful variants of 8. Ship or Kill shipped none.
- **The cost has one main cause.** 5 of the 7 held-back winners had a guardrail, usually crashes at
  about 2%, that a test sized for its primary metric can't rule out.
  - The fix is in planning, not in the rule. Spotify's "Risk-aware product decisions in A/B tests with
    multiple metrics" (Schultzberg, Ankargren and Frånberg, 2024) reaches the same conclusion: power must
    cover every check.
  - The planner now sizes tests that way. For an onboarding test with an 8% minimum effect and a tight D1
    guardrail, that is 31,565 per arm instead of 7,550.

**Public experiments** (not part of the gate; their true effects are unknown):

| Experiment | Call | Why |
| --- | --- | --- |
| **Cookie Cats** (90,189 players, first gate at level 40 instead of 30) | **Kill** | D7 retention -0.82 points, 95% CI -1.3 to -0.31. The sample ratio is borderline (p = 0.0086) and is flagged |
| **Udacity free-trial screener** | **Iterate** | Enrolments fell as intended (-2.1 points), but the test can't rule out losing paying students beyond the course's own 0.75-point boundary. Payments *per enrolment* rose, the same conditional-metric pattern |

**What this can't show:**
- The simulated users are not real users, and the case mix is chosen, not observed. Results are reported
  by case type for that reason.
- The same person designed the traps and the engine. The held-out-only case types and the public
  experiments are the partial answer.

## How it works

The engine is one dependency-free JavaScript file, [site/shiporkill.js](site/shiporkill.js). The page loads
it, and the benchmark runner scored it.

| Step | Rule |
| --- | --- |
| Trust | Chi-square sample ratio test against the planned split, overall and per segment; fails at p < 0.001. Tracking audits fail above their limit, or when the arms differ at p < 0.001 and one rate is over 2x the other |
| Done | Final at the planned days and ≥ 90% of the planned sample. Before that, only a kill for clear harm (p < 0.001) |
| Primary | 95% Agresti-Caffo interval of the difference, per assigned user. WIN, LOSS, FLAT (rules out the minimum worthwhile effect) or INCONCLUSIVE |
| Guardrails | Non-inferiority at one-sided 5% (90% interval) against a relative margin: PASS, BREACH or UNCLEAR |
| Call | Roll out = WIN and all PASS. Iterate = WIN with BREACH or UNCLEAR, or INCONCLUSIVE. Kill = LOSS, FLAT, or INCONCLUSIVE with a BREACH |

### The request

The page and the engine take the same JSON. Counts per arm; every denominator is the users whose metric
window has closed.

```json
{
  "plan": { "per_arm": 14029, "days": 21, "split": 0.5, "alpha": 0.05 },
  "readout": { "day": 23, "enrolment_days": 21 },
  "assigned": { "control": 14102, "test": 13987 },
  "segments": [ { "name": "android_old", "control": 1690, "test": 1702 } ],
  "metrics": [
    { "id": "act", "label": "D0 couple activation", "role": "primary", "better": "up", "den_kind": "assigned",
      "mwe_rel": 0.08, "control": { "num": 3521, "den": 14102 }, "test": { "num": 3790, "den": 13987 } },
    { "id": "d1", "label": "D1 retention", "role": "guardrail", "better": "up", "den_kind": "assigned",
      "margin_rel": 0.06, "control": { "num": 4230, "den": 14102 }, "test": { "num": 4251, "den": 13987 } }
  ],
  "audits": [
    { "id": "shared_without_partner", "label": "Shared game with no partner joined", "threshold": 0.005,
      "control": { "num": 9, "den": 14102 }, "test": { "num": 11, "den": 13987 } }
  ]
}
```

- **Roles:** `role` is `primary` (exactly one), `guardrail` or `secondary`.
- **Subset metrics:** a primary with `"den_kind": "subset"` (measured only on users who passed a step after
  assignment) must name its per-assigned version in `itt_twin`.
- **No plan:** leave out `plan.per_arm` or `plan.days`, and the test is read as finished at the size it ran.
- **From PostHog-style events:** [sql/readout.sql](sql/readout.sql) produces these counts (DuckDB SQL).

## Run it

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Windows; use .venv/bin on macOS/Linux
python -m sim.build_benchmark          # rebuild the 136 cases (identical to the committed ones)
node eval/run.js holdout && python -m eval.score holdout
python -m pytest -q tests && node --test tests/engine.test.js
python -m scripts.build_site_data      # data for the page; then serve site/ with any static server
```

**Data:**
- the benchmark is simulated (`sim/`);
- Cookie Cats and the Udacity screener are public datasets, with provenance in
  [data/README.md](data/README.md).

Built with Claude Code, after [Why Did It Drop?](https://github.com/AKSHAYKUMARDHAR/Why-Did-It-Drop),
[RBI Circular Radar](https://github.com/AKSHAYKUMARDHAR/RBI-Circular-Radar),
[Will My Policy Pay?](https://github.com/AKSHAYKUMARDHAR/Will-My-Policy-Pay) and
[Is This a Scam?](https://github.com/AKSHAYKUMARDHAR/Is-This-A-Scam).
