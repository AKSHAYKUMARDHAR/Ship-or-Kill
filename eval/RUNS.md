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

**Release run 1**, engine frozen at commit e81e1d7 (sha256 `68c7326196a9`), run once
([results](results/holdout.json), [score](results/holdout_score.md)). **The gate passed.**

| | Ship or Kill | Naive (primary p < 0.05) | Naive + significant-guardrail veto |
| --- | --- | --- | --- |
| Wrong roll-outs (of non-winners) | **0/64 (0%)** | 39/64 (61%) | 19/64 (30%) |
| Harmful roll-outs (of harmful) | **0/48 (0%)** | 31/48 (65%) | 11/48 (23%) |
| Data problems caught | **24/24 (100%)** | 0/24 | 0/24 |
| False data alarms (of clean cases) | 0/64 | 0/64 | 0/64 |
| Winners killed | 0/24 | 0/24 | 0/24 |
| Missed winners (of clean winners) | **7/16 (44%)** | 2/16 (12%) | 2/16 (12%) |

| Family | Truth | n | Ship or Kill | Naive | Naive + guardrails |
| --- | --- | --- | --- | --- | --- |
| clean_win | winner | 8 | roll out 6, iterate 2 | roll out 8 | roll out 8 |
| clean_null | neutral | 8 | iterate 3, kill 5 | iterate 8 | iterate 8 |
| clean_loss | harmful | 8 | kill 8 | iterate 1, kill 7 | iterate 1, kill 7 |
| denominator_trap | harmful | 8 | kill 8 | roll out 7, iterate 1 | roll out 1, iterate 7 |
| guardrail_loud | harmful | 8 | iterate 8 | roll out 8 | iterate 8 |
| srm_bug | harmful (data) | 8 | fix data 8 | roll out 1, iterate 7 | roll out 1, iterate 7 |
| tracking_bug | harmful (data) | 8 | fix data 8 | roll out 7, iterate 1 | roll out 6, iterate 2 |
| peeking | neutral | 8 | keep running 8 | roll out 8 | roll out 8 |
| guardrail_quiet (unseen) | harmful | 8 | iterate 8 | roll out 8 | roll out 3, iterate 5 |
| split_couples (unseen) | winner (data) | 8 | fix data 8 | roll out 5, iterate 3 | roll out 5, iterate 3 |
| underpowered_win (unseen) | winner | 8 | roll out 3, iterate 5 | roll out 6, iterate 2 | roll out 6, iterate 2 |

**Hypothesis, as stated in the PRD before any case existed:**

- The naive rule ships at least 20% of non-winners: **yes, 61%**.
- Ship or Kill ships at most 5%: **yes, 0%**.
- Ship or Kill misses at most 15 points more true winners than the naive rule: **no**. It missed 44% against
  12%, 31 points more.

**What the run shows:**

- **The trust checks did the most work.**
  - 24 of 24 broken tests were stopped, against 0 for both baselines.
  - The naive rule would have shipped 1 of 8 SRM bugs and 7 of 8 tracking bugs.
  - It would have shipped 5 of 8 split-couple tests. Those changes are real winners, so shipping them does no
    harm. But the measured effect is diluted to about half, which is the wrong number to plan the next test on.
- **The denominator trap fooled the usual rule 7 times in 8.** In every one, D1 retention "of activated
  couples" truly rose while D1 per installer truly fell. A significance veto on activation caught 6 of the 7.
  Reading per installer caught all 8.
- **Non-inferiority matters most when harm is close to the margin.** On the quiet-harm family (never seen
  in development), a significance veto still shipped 3 harmful variants of 8. Non-inferiority shipped none.
- **The cost is real, and it has one main cause.** 5 of the 7 missed winners had a guardrail, usually
  crashes, that the test was too small to rule out. The other 2 were too small to tell at all. Development
  showed the same thing, and the planner now sizes tests for every check. The benchmark's tests were sized
  the common way, for the primary only, so this cost is what a team pays when it adds non-inferiority
  guardrails without re-sizing.
- **Peeking:** all 8 peeked nulls would have shipped under both baselines; Ship or Kill said "keep running"
  to all 8.
