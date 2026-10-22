"""The couples-app user model.

Every installer has a latent commitment u ~ N(segment shift, 1). They then move through the funnel:
onboarding, partner invite, partner joined, first shared game within 24 hours (= D0 couple activation).
They come back on day 1 and day 7, and may disable push, crash or uninstall within 48 hours. Each step is
a logistic function of u and the earlier steps. The test arm adds logit shifts to chosen steps.

`expected()` integrates the model exactly over u (Gauss-Hermite) to give the true rates behind a case's
truth label. `simulate_users()` draws individual users from the same model for the event log.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
from scipy.optimize import brentq
from scipy.special import expit, logit

# Segment: share of installers, shift of mean commitment. India-like mix: mostly Android, some old devices.
SEGMENTS = {"android_new": (0.68, 0.0), "android_old": (0.12, -0.4), "ios": (0.20, 0.2)}

# Slopes (fixed for every case)
ONB_U, INV_U, JOIN_U, SHARED_U, JOIN_IOS = 0.5, 0.6, 0.4, 0.5, 0.2
D1_ACT, D1_ONB, D1_U = 1.6, 0.5, 0.9
D7_ACT, D7_D1, D7_U = 1.0, 1.4, 1.0
UN_U, UN_D1 = -0.4, -1.0
PUSH_U = -0.2
CRASH_OLD = 0.4
LOW_U_SLOPE = 1.5  # onboarding friction that bites low-commitment users harder: onb_low * 2 * sigmoid(-1.5 u)

# Users hit by the "crash before exposure" bug: what really happens to them (they never reach the data)
SRM_D1_FACTOR, SRM_UN_SHIFT = 0.5, 1.5

_GH_X, _GH_W = np.polynomial.hermite.hermgauss(64)


@dataclass(frozen=True)
class Base:
    """Control-arm intercepts (logits)."""
    a_onb: float
    a_inv: float
    a_join: float
    a_shared: float
    b0: float = 0.0
    c0: float = 0.0
    h0: float = 0.0
    g0: float = 0.0
    k0: float = 0.0


@dataclass(frozen=True)
class Shift:
    """Logit shifts applied to the test arm."""
    onb: float = 0.0
    onb_low: float = 0.0
    inv: float = 0.0
    join: float = 0.0
    shared: float = 0.0
    d1: float = 0.0
    d7: float = 0.0
    un: float = 0.0
    push: float = 0.0
    crash: float = 0.0

    def scaled(self, k: float) -> "Shift":
        return Shift(*(k * getattr(self, f) for f in self.__dataclass_fields__))

    def without_couple_steps(self) -> "Shift":
        return replace(self, join=0.0, shared=0.0)


NO_SHIFT = Shift()


def _chain(base: Base, s: Shift, u: np.ndarray, ios: bool, old: bool) -> dict[str, np.ndarray]:
    """Probabilities at commitment values u for one segment."""
    p_onb = expit(base.a_onb + ONB_U * u + s.onb - s.onb_low * 2 * expit(-LOW_U_SLOPE * u))
    p_inv = expit(base.a_inv + INV_U * u + s.inv)
    p_join = expit(base.a_join + JOIN_U * u + JOIN_IOS * ios + s.join)
    p_shared = expit(base.a_shared + SHARED_U * u + s.shared)
    act = p_onb * p_inv * p_join * p_shared
    onb_noact = p_onb - act
    no_onb = 1 - p_onb
    q_act = expit(base.b0 + D1_ACT + D1_ONB + D1_U * u + s.d1)
    q_onb = expit(base.b0 + D1_ONB + D1_U * u + s.d1)
    q_no = expit(base.b0 + D1_U * u + s.d1)
    d1 = act * q_act + onb_noact * q_onb + no_onb * q_no

    def r(a, d):
        return expit(base.c0 + D7_ACT * a + D7_D1 * d + D7_U * u + s.d7)

    d7 = (act * (q_act * r(1, 1) + (1 - q_act) * r(1, 0))
          + onb_noact * (q_onb * r(0, 1) + (1 - q_onb) * r(0, 0))
          + no_onb * (q_no * r(0, 1) + (1 - q_no) * r(0, 0)))
    un = d1 * expit(base.h0 + UN_U * u + UN_D1 + s.un) + (1 - d1) * expit(base.h0 + UN_U * u + s.un)
    push = expit(base.g0 + PUSH_U * u + s.push) * np.ones_like(u)
    crash = expit(base.k0 + CRASH_OLD * old + s.crash) * np.ones_like(u)
    return {"onb": p_onb, "act": act, "act_d1": act * q_act, "d1": d1, "d7": d7, "un": un, "push": push,
            "crash": crash}


def _srm_victims(base: Base, u: np.ndarray) -> dict[str, np.ndarray]:
    """True outcomes of users whose app crashes before the experiment exposure is logged."""
    q = SRM_D1_FACTOR * expit(base.b0 + D1_U * u)
    r = lambda d: expit(base.c0 + D7_D1 * d + D7_U * u)  # noqa: E731
    zero = np.zeros_like(u)
    return {"onb": zero, "act": zero, "act_d1": zero, "d1": q, "d7": q * r(1) + (1 - q) * r(0),
            "un": q * expit(base.h0 + UN_U * u + UN_D1 + SRM_UN_SHIFT) + (1 - q) * expit(base.h0 + UN_U * u + SRM_UN_SHIFT),
            "push": expit(base.g0 + PUSH_U * u) * np.ones_like(u), "crash": np.ones_like(u)}


def expected(base: Base, s: Shift = NO_SHIFT, couple_share: float = 1.0, srm_crash: float = 0.0) -> dict[str, float]:
    """Exact expected per-installer rates for one arm.

    couple_share: share of couples where both partners get this arm's experience (1 when the invitee
    inherits the inviter's variant). The join and shared-game shifts only act on those couples.
    srm_crash: share of old-Android users in this arm whose app crashes before exposure (true outcomes).
    """
    tot = {k: 0.0 for k in ("onb", "act", "act_d1", "d1", "d7", "un", "push", "crash")}
    for seg, (w, mu) in SEGMENTS.items():
        u = mu + np.sqrt(2) * _GH_X
        ww = _GH_W / np.sqrt(np.pi)
        ios, old = seg == "ios", seg == "android_old"
        full = _chain(base, s, u, ios, old)
        part = _chain(base, s.without_couple_steps(), u, ios, old) if couple_share < 1 else full
        crash_share = srm_crash if old else 0.0
        victims = _srm_victims(base, u) if crash_share else None
        for k in tot:
            v = couple_share * full[k] + (1 - couple_share) * part[k]
            if victims is not None:
                v = (1 - crash_share) * v + crash_share * victims[k]
            tot[k] += w * float(np.sum(ww * v))
    tot["d1_given_act"] = tot["act_d1"] / tot["act"]
    return tot


def calibrate(rng: np.random.Generator) -> tuple[Base, dict[str, float]]:
    """Draw a control arm: funnel intercepts, then solve the outcome intercepts to hit target rates."""
    jitter = lambda p, sd=0.12: logit(p) + rng.normal(0, sd)  # noqa: E731
    base = Base(a_onb=jitter(0.78), a_inv=jitter(0.62), a_join=jitter(0.58), a_shared=jitter(0.85))
    targets = {"d1": rng.uniform(0.27, 0.34), "d7": rng.uniform(0.11, 0.15), "un": rng.uniform(0.07, 0.10),
               "push": rng.uniform(0.05, 0.07), "crash": rng.uniform(0.015, 0.025)}
    for field_, metric in (("b0", "d1"), ("c0", "d7"), ("h0", "un"), ("g0", "push"), ("k0", "crash")):
        f = lambda x: expected(replace(base, **{field_: x}))[metric] - targets[metric]  # noqa: E731,B023
        base = replace(base, **{field_: brentq(f, -12, 6)})
    return base, expected(base)


def solve_shift(base: Base, direction: Shift, metric: str, target_diff: float, **kw) -> Shift:
    """Scale a shift direction so the test arm's expected `metric` differs from control by target_diff."""
    ctrl = expected(base)[metric]

    def gap(k):
        return expected(base, direction.scaled(k), **kw)[metric] - ctrl - target_diff

    g0 = gap(0.0)
    if g0 == 0:
        return direction.scaled(0.0)
    for sign in (1.0, -1.0):
        end = 0.5 * sign
        while abs(end) <= 64:
            if g0 * gap(end) <= 0:
                return direction.scaled(brentq(gap, min(0.0, end), max(0.0, end)))
            end *= 2
    raise ValueError(f"cannot reach {metric} diff {target_diff}")


def combine(*shifts: Shift) -> Shift:
    out = {f: 0.0 for f in Shift.__dataclass_fields__}
    for s in shifts:
        for f in out:
            out[f] += getattr(s, f)
    return Shift(**out)


# ----------------------------------------------------------------------------------------------------------
# Drawing users


def simulate_users(rng: np.random.Generator, base: Base, s: Shift, n: int, *, split_couples: bool = False,
                   srm_crash: float = 0.0) -> dict[str, np.ndarray]:
    """Draw n installers of one arm. Returns per-user outcomes (bool arrays) and segment labels.

    With split_couples, each invitee gets an independent 50/50 arm (in both arms), and the test arm's join and
    shared-game shifts act only when the invitee is also in test. srm_crash marks old-Android users whose app crashes
    before exposure; they are returned with lost=True and never reach the event log.
    """
    names = list(SEGMENTS)
    seg = rng.choice(len(names), size=n, p=[SEGMENTS[k][0] for k in names])
    mu = np.array([SEGMENTS[k][1] for k in names])[seg]
    u = mu + rng.normal(size=n)
    ios = seg == names.index("ios")
    old = seg == names.index("android_old")

    partner_test = rng.random(n) < 0.5 if split_couples else np.ones(n, dtype=bool)
    s_join = np.where(partner_test, s.join, 0.0)
    s_shared = np.where(partner_test, s.shared, 0.0)

    onb = rng.random(n) < expit(base.a_onb + ONB_U * u + s.onb - s.onb_low * 2 * expit(-LOW_U_SLOPE * u))
    inv = onb & (rng.random(n) < expit(base.a_inv + INV_U * u + s.inv))
    join = inv & (rng.random(n) < expit(base.a_join + JOIN_U * u + JOIN_IOS * ios + s_join))
    act = join & (rng.random(n) < expit(base.a_shared + SHARED_U * u + s_shared))
    d1 = rng.random(n) < expit(base.b0 + D1_ACT * act + D1_ONB * onb + D1_U * u + s.d1)
    d7 = rng.random(n) < expit(base.c0 + D7_ACT * act + D7_D1 * d1 + D7_U * u + s.d7)
    un = rng.random(n) < expit(base.h0 + UN_U * u + UN_D1 * d1 + s.un)
    push = rng.random(n) < expit(base.g0 + PUSH_U * u + s.push)
    crash = rng.random(n) < expit(base.k0 + CRASH_OLD * old + s.crash)

    lost = old & (rng.random(n) < srm_crash) if srm_crash else np.zeros(n, dtype=bool)
    return {"segment": np.array(names)[seg], "onb": onb, "inv": inv, "join": join, "act": act, "d1": d1,
            "d7": d7, "un": un, "push": push, "crash": crash, "lost": lost, "partner_test": partner_test}
