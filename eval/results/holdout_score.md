# holdout: 88 cases, engine 1.0 (68c7326196a9)

| | Ship or Kill | Naive (primary p < 0.05) | Naive + significant-guardrail veto |
| --- | --- | --- | --- |
| Wrong roll-outs (of non-winners) | 0/64 (0%) | 39/64 (61%) | 19/64 (30%) |
| Harmful roll-outs (of harmful) | 0/48 (0%) | 31/48 (65%) | 11/48 (23%) |
| Data problems caught | 24/24 (100%) | 0/24 (0%) | 0/24 (0%) |
| False data alarms (of clean cases) | 0/64 (0%) | 0/64 (0%) | 0/64 (0%) |
| Winners killed | 0/24 (0%) | 0/24 (0%) | 0/24 (0%) |
| Missed winners (of clean winners) | 7/16 (44%) | 2/16 (12%) | 2/16 (12%) |

## Release gate (Ship or Kill)

- PASS: Wrong roll-outs ≤ 5% of non-winners: 0/64 (0%)
- PASS: Data problems caught ≥ 90%: 24/24 (100%)
- PASS: False data alarms ≤ 5% of clean cases: 0/64 (0%)
- PASS: Winners killed ≤ 5% of true winners: 0/24 (0%)
- **Gate: PASSED**

## Hypothesis

- Naive ships ≥ 20% of non-winners: 61% → yes
- Ship or Kill ships ≤ 5%: 0% → yes
- Misses ≤ 15 points more winners than naive: 44% vs 12% (+31 points) → no

## By family

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
| guardrail_quiet | harmful | 8 | iterate 8 | roll out 8 | roll out 3, iterate 5 |
| split_couples | winner (data) | 8 | fix data 8 | roll out 5, iterate 3 | roll out 5, iterate 3 |
| underpowered_win | winner | 8 | roll out 3, iterate 5 | roll out 6, iterate 2 | roll out 6, iterate 2 |

