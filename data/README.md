# Data

## `benchmark/`

The frozen benchmark: `dev.json` (48 cases) and `holdout.json` (88 cases), simulated. How it was built
and what it can show: [BENCHMARK_GUIDE.md](BENCHMARK_GUIDE.md).

## `real/`: two public experiments

**Cookie Cats** (`cookie_cats.csv`): an A/B test in the mobile puzzle game Cookie Cats by Tactile
Entertainment. When a player installed the game during the test, the first gate (a forced wait or
purchase) was placed at level 30 (`gate_30`, control) or level 40 (`gate_40`). The file has one row per
player:
- `userid` and `version` (the arm);
- `sum_gamerounds`: rounds played in the first 14 days;
- `retention_1` and `retention_7`: whether the player came back 1 day and 7 days after installing.

There are 90,189 players. The dataset was published by Rasmus Bååth for a DataCamp project. This copy is
from `github.com/basilghauri/a-b-testing-of-mobile-game` and was checked for the expected row count and
columns.

**Udacity free-trial screener** (`udacity_screener_control.csv`, `udacity_screener_experiment.csv`):
the final-project data of Udacity's A/B Testing course (by Google). In the experiment, students who
clicked "start free trial" were asked how many hours a week they could study. Those who answered fewer
than 5 hours saw a warning and could switch to free course materials. The files have daily counts per
arm, 11 October to 16 November:
- pageviews;
- clicks on "start free trial";
- enrolments;
- payments (the last two only up to 2 November).

This copy is from `github.com/baumanab/udacity_ABTesting` and is identical to a second, independent
copy (`github.com/owentemple/data-science`). The course presents it as an experiment Udacity ran. I could
not confirm whether the numbers are unaltered, so it is treated as a teaching dataset.
