# dev: 48 cases, engine 1.0 (68c7326196a9)

| | Ship or Kill | Naive (primary p < 0.05) | Naive + significant-guardrail veto |
| --- | --- | --- | --- |
| Wrong roll-outs (of non-winners) | 0/42 (0%) | 21/42 (50%) | 13/42 (31%) |
| Harmful roll-outs (of harmful) | 0/30 (0%) | 15/30 (50%) | 7/30 (23%) |
| Data problems caught | 12/12 (100%) | 0/12 (0%) | 0/12 (0%) |
| False data alarms (of clean cases) | 0/36 (0%) | 0/36 (0%) | 0/36 (0%) |
| Winners killed | 0/6 (0%) | 0/6 (0%) | 0/6 (0%) |
| Missed winners (of clean winners) | 3/6 (50%) | 0/6 (0%) | 0/6 (0%) |

## Release gate (Ship or Kill)

- PASS: Wrong roll-outs ≤ 5% of non-winners: 0/42 (0%)
- PASS: Data problems caught ≥ 90%: 12/12 (100%)
- PASS: False data alarms ≤ 5% of clean cases: 0/36 (0%)
- PASS: Winners killed ≤ 5% of true winners: 0/6 (0%)
- **Gate: PASSED**

## Hypothesis

- Naive ships ≥ 20% of non-winners: 50% → yes
- Ship or Kill ships ≤ 5%: 0% → yes
- Misses ≤ 15 points more winners than naive: 50% vs 0% (+50 points) → no

## By family

| Family | Truth | n | Ship or Kill | Naive | Naive + guardrails |
| --- | --- | --- | --- | --- | --- |
| clean_win | winner | 6 | roll out 3, iterate 3 | roll out 6 | roll out 6 |
| clean_null | neutral | 6 | iterate 1, kill 5 | iterate 5, kill 1 | iterate 5, kill 1 |
| clean_loss | harmful | 6 | kill 6 | iterate 1, kill 5 | iterate 1, kill 5 |
| denominator_trap | harmful | 6 | iterate 1, kill 5 | roll out 4, iterate 2 | roll out 3, iterate 3 |
| guardrail_loud | harmful | 6 | iterate 6 | roll out 6 | iterate 6 |
| srm_bug | harmful (data) | 6 | fix data 6 | roll out 1, iterate 5 | roll out 1, iterate 5 |
| tracking_bug | harmful (data) | 6 | fix data 6 | roll out 4, iterate 2 | roll out 3, iterate 3 |
| peeking | neutral | 6 | keep running 6 | roll out 6 | roll out 6 |

