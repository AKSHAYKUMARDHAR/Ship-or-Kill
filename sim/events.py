"""Turn simulated installers into a PostHog-style event log.

Columns: distinct_id, event, ts (seconds since the experiment started), variant and segment (on the
exposure event), partner_variant (on partner_joined). Includes the noise real tracking has: about 0.3% of
events lost, a few users exposed to both arms, a few partners who were already in the other arm.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from sim.model import Base, Shift, simulate_users

DAY = 86400.0
WEEKDAY_WEIGHT = np.array([1.0, 0.95, 0.95, 1.0, 1.1, 1.25, 1.2])  # Mon..Sun
EVENT_LOSS = 0.003
BOTH_ARMS_RATE = 0.0005
NATURAL_SPLIT_RATE = 0.003


def _enrolment_times(rng: np.random.Generator, n: int, days: int, start_weekday: int) -> np.ndarray:
    w = WEEKDAY_WEIGHT[(start_weekday + np.arange(days)) % 7]
    day = rng.choice(days, size=n, p=w / w.sum())
    evening = rng.random(n) < 0.6  # couples use the app most between 9 pm and midnight
    tod = np.where(evening, rng.uniform(21 * 3600, DAY, n), rng.uniform(0, DAY, n))
    return day * DAY + tod


def build_events(rng: np.random.Generator, base: Base, shift: Shift, *, n_total: int, days: int,
                 split: float = 0.5, start_weekday: int = 0, split_couples: bool = False,
                 srm_crash: float = 0.0, tracking_bug: float = 0.0) -> pd.DataFrame:
    """Simulate one experiment's enrolment and return its event log."""
    is_test = rng.random(n_total) < split
    t0 = _enrolment_times(rng, n_total, days, start_weekday)
    users = {}
    for arm, mask, s in (("control", ~is_test, Shift()), ("test", is_test, shift)):
        users[arm] = simulate_users(rng, base, s, int(mask.sum()), split_couples=split_couples,
                                    srm_crash=srm_crash if arm == "test" else 0.0)
        users[arm]["t0"] = t0[mask]
        users[arm]["id"] = np.flatnonzero(mask) + 1

    frames = []
    for arm, u in users.items():
        keep = ~u["lost"]  # users whose app crashed before exposure never reach the log
        u = {k: v[keep] for k, v in u.items()}
        frames.append(_arm_events(rng, arm, u, split_couples=split_couples,
                                  tracking_bug=tracking_bug if arm == "test" else 0.0))
    ev = pd.concat(frames, ignore_index=True)

    exposure = ev["event"] == "$feature_flag_called"
    lost = (~exposure) & (rng.random(len(ev)) < EVENT_LOSS)
    ev = ev[~lost]
    return ev.sort_values(["ts", "distinct_id"], kind="stable").reset_index(drop=True)


def _frame(ids, event, ts, **cols) -> pd.DataFrame:
    df = pd.DataFrame({"distinct_id": ids.astype(np.int64), "event": event, "ts": ts.astype(float)})
    for k in ("variant", "segment", "partner_variant"):
        df[k] = cols.get(k, None)
    return df


def _arm_events(rng, arm: str, u: dict, *, split_couples: bool, tracking_bug: float) -> pd.DataFrame:
    n = len(u["id"])
    ids, t0 = u["id"], u["t0"]
    other = "control" if arm == "test" else "test"
    out = [_frame(ids, "$feature_flag_called", t0, variant=arm, segment=u["segment"]),
           _frame(ids, "app_opened", t0 + rng.uniform(1, 30, n))]

    both = rng.random(n) < BOTH_ARMS_RATE
    out.append(_frame(ids[both], "$feature_flag_called", t0[both] + rng.uniform(3600, 3 * DAY, both.sum()),
                      variant=other, segment=u["segment"][both]))

    t_onb = t0 + rng.uniform(60, 600, n)
    t_inv = t_onb + rng.uniform(60, 3600, n)
    deadline = t0 + DAY - 300
    t_join_act = t_inv + rng.uniform(0.05, 0.9, n) * np.maximum(deadline - t_inv, 60)
    t_join_late = t_inv + rng.uniform(600, 2 * DAY, n)
    t_join = np.where(u["act"], t_join_act, t_join_late)
    t_shared_act = t_join + rng.uniform(0.1, 0.95, n) * np.maximum(t0 + DAY - t_join, 30)
    late_shared = u["join"] & ~u["act"] & (rng.random(n) < 0.4)
    t_shared_late = np.maximum(t0 + DAY, t_join) + rng.uniform(60, 5 * DAY, n)

    if split_couples:
        pv = np.where(u["partner_test"], "test", "control")
    else:
        pv = np.where(rng.random(n) < NATURAL_SPLIT_RATE, other, arm)

    m = u["onb"]
    out.append(_frame(ids[m], "onboarding_completed", t_onb[m]))
    m = u["inv"]
    out.append(_frame(ids[m], "partner_invite_sent", t_inv[m]))
    m = u["join"]
    out.append(_frame(ids[m], "partner_joined", t_join[m], partner_variant=pv[m]))
    m = u["act"]
    out.append(_frame(ids[m], "shared_game_completed", t_shared_act[m]))
    out.append(_frame(ids[late_shared], "shared_game_completed", t_shared_late[late_shared]))
    if tracking_bug:
        # Bug in the test build: the solo warm-up game sends shared_game_completed
        m = u["onb"] & (rng.random(n) < tracking_bug)
        out.append(_frame(ids[m], "shared_game_completed", t_onb[m] + rng.uniform(60, 900, m.sum())))

    t_d1 = t0 + rng.uniform(DAY, 2 * DAY, n)
    m = u["d1"]
    out.append(_frame(ids[m], "app_opened", t_d1[m]))
    extra = u["d1"] & (rng.random(n) < 0.5)
    out.append(_frame(ids[extra], "app_opened", t0[extra] + rng.uniform(2 * DAY, 7 * DAY, extra.sum())))
    m = u["d7"]
    out.append(_frame(ids[m], "app_opened", t0[m] + rng.uniform(7 * DAY, 8 * DAY, m.sum())))

    m = u["push"]
    out.append(_frame(ids[m], "push_disabled", t0[m] + rng.uniform(0, 2 * DAY, m.sum())))
    m = u["crash"]
    out.append(_frame(ids[m], "app_crashed", t0[m] + rng.uniform(0, 2 * DAY, m.sum())))
    t_un = np.where(u["d1"], t_d1 + rng.uniform(0, 1, n) * (t0 + 2 * DAY - t_d1), t0 + rng.uniform(0, 2 * DAY, n))
    m = u["un"]
    out.append(_frame(ids[m], "app_uninstalled", t_un[m]))
    return pd.concat(out, ignore_index=True)
