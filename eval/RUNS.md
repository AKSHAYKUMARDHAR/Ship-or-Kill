# Evaluation runs

Every run, in order. The benchmark (`data/benchmark/`, rules in
[data/BENCHMARK_GUIDE.md](../data/BENCHMARK_GUIDE.md)) was frozen in commit 77b8873, before any engine code
existed. Development runs are for building. The held-out set is run once, with the engine frozen in git
first.

```bash
node eval/run.js dev && python -m eval.score dev
```

The engine is deterministic, so every run can be repeated exactly from its commit.

## Development (48 cases: 8 families x 6)

### Run 1: engine 1.0 as specified in the PRD ([results](results/dev_run1.json))

| | Ship or Kill | Naive (primary p < 0.05) | Naive + significant-guardrail veto |
| --- | --- | --- | --- |
| Wrong roll-outs (of non-winners) | **0/42 (0%)** | 21/42 (50%) | 13/42 (31%) |
| Harmful roll-outs (of harmful) | **0/30 (0%)** | 15/30 (50%) | 7/30 (23%) |
| Data problems caught | **12/12 (100%)** | 0/12 | 0/12 |
| False data alarms (of clean cases) | 0/36 | 0/36 | 0/36 |
| Winners killed | 0/6 | 0/6 | 0/6 |
| Missed winners (of clean winners) | **3/6 (50%)** | 0/6 | 0/6 |

**The gate passes. The hypothesis fails on its cost clause:** Ship or Kill missed 50 points more of the true
winners than the naive rule (limit: 15).

All three missed winners have the same cause:
- **The trigger:** the crash guardrail (about 2% of users, margin +25% relative, so about 0.5 points).
- **The size problem:** the tests were sized for their primary metric, 5,000-7,000 per arm. Ruling out a
  0.5-point rise in a 2% rate needs about 11,000-15,000 per arm.
- **The result:** the guardrail stayed "can't rule out", so the call was "iterate: extend the test".
- **The true crash effect was zero in all three.**

**Decision: no change to the decision rule.**
- Calling these winners would mean shipping when a guardrail can't be ruled out, which is the
  significance rule the PRD argues against.
- It would also cost the held-out set's quiet-harm family, which the engine was never tuned on.
- The fix belongs before the test, in planning. It is the same conclusion as Spotify's
  "Risk-aware product decisions in A/B tests with multiple metrics" (Schultzberg, Ankargren and Frånberg,
  2024): with non-inferiority guardrails, the sample size must be powered for every check, not just the
  success metric.

### Changes after run 1, none of which changes a verdict

Checked by re-running dev: all 48 verdicts are identical to run 1.

- **Wording:**
  - the "fix the data" next step now names what to check for the failure found;
  - the denominator-trap headline explains why the registered "of activated couples" metric rose;
  - "can't tell" at full sample size no longer says "rerun with about the same number";
  - acronyms like D1 are no longer lower-cased mid-sentence.
- **Planner sizes the test for every check:** each of the 1 + G checks (primary and G guardrails) gets
  power 1 - (1 - power) / (1 + G), the correction in the Spotify paper. The recommended size is the
  largest any check needs. Example:

  | Planner input | Per arm | Days |
  | --- | --- | --- |
  | Onboarding test, primary activation 25%, minimum worthwhile effect 8%, 1,500 installs a day | 7,550 | 14 |
  | Same test with D1 retention (margin -4%), uninstall and crash guardrails | 31,565 | 49 |

  The test needs four times the sample.
- **Readout:** for a guardrail that can't be ruled out, the readout states the sample per arm that would
  rule it out at 80% power.

### Run 2: the frozen engine ([results](results/dev.json), [score](results/dev_score.md))

Same numbers as run 1. Engine 1.0, `site/shiporkill.js` sha256 `68c7326196a9`.

**Frozen for the release run:** this commit's `site/shiporkill.js`.

## Held-out (88 cases: 11 families x 8, three never seen in development)

Not run yet.
