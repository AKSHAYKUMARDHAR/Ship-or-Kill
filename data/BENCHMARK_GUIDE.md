# How the benchmark was built

136 simulated A/B tests on a couples app, each with a known true effect. 48 are for development, 88 are
held out and run once. Both sets were generated and committed before any engine code existed.

Rebuild: `python -m sim.build_benchmark` (about 3 minutes; the output is identical byte for byte with
the versions in `meta`).

## The simulated app

Every installer gets a latent commitment, drawn from a normal distribution whose mean depends on the
segment:

| Segment | Share | Mean commitment |
| --- | --- | --- |
| Android, newer devices | 68% | 0 |
| Android, old devices | 12% | -0.4 |
| iOS | 20% | +0.2 |

The installer then moves through the funnel (`sim/model.py`). Every step is a logistic function of
commitment and the earlier steps:

1. onboarding;
2. partner invite;
3. partner joins;
4. first shared game within 24 hours (= **D0 couple activation**);
5. app opened on day 1 (**D1 retention**) and day 7 (**D7 retention**);
6. push disabled, crash or uninstall within 48 hours.

Control rates are drawn per case, with about these values:

| Metric | Control rate |
| --- | --- |
| D0 couple activation | about 25% |
| D1 retention | 27-34% |
| D7 retention | 11-15% |
| Uninstalls within 48 h | 7-10% |
| Push disabled within 48 h | 5-7% |
| Users with a crash within 48 h | 1.5-2.5% |

**These are illustrative rates, not any company's data.**

The test arm adds logit shifts to chosen steps. A shift can bite harder on low-commitment users, which is
how a selection effect is made.

## From users to readout counts

Each experiment enrols users over 7 or 14 days. Users are randomised 50/50 one at a time, so arm sizes
vary as they would in a real test. Enrolment follows a weekly pattern, with most sign-ups between 9 pm
and midnight.

`sim/events.py` writes a PostHog-style event log for every user. It includes three kinds of noise real
tracking has:
- 0.3% of events are lost;
- 0.05% of users are exposed to both arms;
- 0.3% of partners were already in the other arm.

`sql/readout.sql` and `sql/segments.sql` then turn the log into the counts the engine reads, at the
moment of the readout. A user counts in a metric only once that metric's window has closed. Final
readouts happen two days after enrolment ends, so every D0, D1 and 48-hour window is closed.

## Truth labels

The truth comes from the model, not from the sample. `sim.model.expected` integrates the funnel exactly
over commitment (64-point Gauss-Hermite) for both arms of the intended design. That design gives the
partner the installer's variant, and it counts users who were assigned but lost from the data. The model
was checked against a 400,000-user simulation; every rate matched within 0.1 points.

| Label | Rule |
| --- | --- |
| **Winner** | The per-assigned primary improves by at least the minimum worthwhile effect, and no guardrail is harmed beyond its margin |
| **Harmful** | The per-assigned primary gets worse, or a guardrail is harmed beyond its margin |
| **Neutral** | Anything else; every neutral case here has exactly zero true effect |

Each case is drawn until its label matches its family's intended label. The draw is logged as `seed` in
the case.

## Registration (what the team agreed before the test)

Every case carries a registration:

- **Primary metric** with a minimum worthwhile effect: 5-10% relative for activation, 4-8% for D1
  retention.
- **Three guardrails** with non-inferiority margins, relative to control:

  | Guardrail | Margin |
  | --- | --- |
  | D0 couple activation | -8% |
  | D1 retention | -4% |
  | Uninstalls within 48 h | +12% |
  | Push disabled within 48 h | +20% |
  | Users with a crash within 48 h | +25% |

- **Planned sample per arm:** 80% power at two-sided 5% for the primary's minimum worthwhile effect.
- **Planned days:** 7 or 14.

Actual traffic runs at 97-108% of plan.

| Surface | Primary | Guardrails |
| --- | --- | --- |
| Onboarding, invite | D0 couple activation | D1 retention, uninstalls, crashes |
| Home | D1 retention | D0 activation, uninstalls, crashes |
| Push | D1 retention | push disabled, uninstalls, crashes |

## Families

| Family | Cases (dev / held-out) | What is planted | True label |
| --- | --- | --- | --- |
| clean_win | 6 / 8 | Primary truly up by 1.2-2.2x the minimum worthwhile effect | winner |
| clean_null | 6 / 8 | Nothing | neutral |
| clean_loss | 6 / 8 | Primary truly down by 0.8-2x the minimum worthwhile effect | harmful |
| denominator_trap | 6 / 8 | "Pair before play" onboarding gate that filters out low-commitment users. The team registered D1 retention *of activated couples* (with the per-installer version supplied as its twin) and sized the test for it. Drawn so that the conditional rate truly rises ≥ 3%, activation falls 2-12%, and D1 per installer truly falls | harmful |
| guardrail_loud | 6 / 8 | A push change that truly lifts D1 by 1.2-2.2x the minimum worthwhile effect, but raises push disables by 2.5-5x and uninstalls by 1.5-3x their margins | harmful |
| srm_bug | 6 / 8 | The test build crashes on launch, before exposure is logged, for 25-60% of old-Android installers. Those users vanish from the test arm's data; their true outcomes are worse (no activation, half the D1 return, more uninstalls, a crash) | harmful |
| tracking_bug | 6 / 8 | Real activation falls by 0.3-1x the minimum worthwhile effect, but a solo warm-up game sends `shared_game_completed` for 1-10% of onboarded test users | harmful |
| peeking | 6 / 8 | No effect. The team looked every day from day 3 and read the test on the first day the primary showed p < 0.05. Seeds where that never happened before the planned end were redrawn | neutral |
| guardrail_quiet (held-out only) | - / 8 | A smaller test (minimum worthwhile effect 10-14%): D1 truly up 1.2-2.2x it, but uninstalls (push) or crashes (home) truly up 1.1-1.5x their margin | harmful |
| split_couples (held-out only) | - / 8 | The invite change truly lifts activation 1.2-2.2x the minimum worthwhile effect when both partners have it. But partners were randomised separately, so about half the couples are split and the effect is diluted | winner (data problem) |
| underpowered_win (held-out only) | - / 8 | Primary truly up 1.2-2.2x the minimum worthwhile effect, but the test ran at 25-45% of the sample it needs | winner |

`srm_bug`, `tracking_bug` and `split_couples` are the **data-problem** cases: the right call is "fix the
data first", whatever the numbers say.

Case ids are shuffled, so the id says nothing about the family. The engine sees only `request`; the
`truth` block is used for scoring.

## What this benchmark can and can't show

- **It can show** whether each check catches what it is designed for, and what that caution costs in
  missed winners, on data generated independently of the engine's code.
- **It can't show** how often these traps happen in real teams. The family mix is chosen, not observed,
  so the overall rates depend on it. Results are reported by family for that reason.
- **The same person designed the traps and the engine.** The three held-out-only families, and the two
  public experiments reported separately, are the partial answer to that.
