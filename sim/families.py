"""Case families: what each simulated experiment changes, how the team registered it, and its true label.

Registration follows docs/PRD.md: a primary metric with a minimum worthwhile effect (relative), guardrails
with non-inferiority margins (relative to control), a planned sample per arm (80% power, two-sided 5%)
and a planned number of days.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.stats import norm

from sim.model import Base, Shift, combine, expected, solve_shift

# Metric catalogue: label, numerator, denominator (columns of sql/readout.sql), better, denominator kind
METRICS = {
    "act": ("D0 couple activation", "activated_d0", "d0_eligible", "up", "assigned"),
    "d1": ("D1 retention", "retained_d1", "d1_eligible", "up", "assigned"),
    "d1_act": ("D1 retention of activated couples", "d1_activated_retained", "d1_activated", "up", "subset"),
    "d7": ("D7 retention", "retained_d7", "d7_eligible", "up", "assigned"),
    "un": ("Uninstalls within 48 h", "uninstalled_48h", "d1_eligible", "down", "assigned"),
    "push": ("Push disabled within 48 h", "push_disabled_48h", "d1_eligible", "down", "assigned"),
    "crash": ("Users with a crash within 48 h", "crashed_48h", "d1_eligible", "down", "assigned"),
}
# Model rate behind each metric (sim.model.expected keys)
MODEL_KEY = {"act": "act", "d1": "d1", "d1_act": "d1_given_act", "d7": "d7", "un": "un", "push": "push",
             "crash": "crash"}
MARGIN_REL = {"act": 0.08, "d1": 0.04, "un": 0.12, "push": 0.20, "crash": 0.25}
AUDITS = [
    ("shared_without_partner", "Shared game with no partner joined", "shared_without_partner", "assigned", 0.005),
    ("both_arms", "Users exposed to both arms", "both_arms", "exposed", 0.005),
    ("partner_other_arm", "Partner joined from the other arm", "partner_other_arm", "joined_any", 0.01),
]

SURFACES = {
    # primary, guardrails, secondaries, direction of a real improvement
    "onboarding": ("act", ["d1", "un", "crash"], ["d7"], Shift(onb=1.0, inv=0.5)),
    "invite": ("act", ["d1", "un", "crash"], ["d7"], Shift(join=1.0, shared=0.3)),
    "home": ("d1", ["act", "un", "crash"], ["d7", "d1_act"], Shift(d1=1.0, d7=0.3)),
    "push": ("d1", ["push", "un", "crash"], ["d7"], Shift(d1=1.0)),
}

NAMES = {
    "onboarding": ["Three-screen onboarding", "Skip the profile photo step", "Couple goal picker",
                   "Voice-note welcome", "Relationship-stage question first", "Shorter sign-up form"],
    "invite": ["Personal invite message", "WhatsApp-first invite button", "Invite reminder at 9 pm",
               "Invite card with partner's name", "Two-tap invite", "Invite preview of the first game"],
    "home": ["Game of the day on home", "Couple streak on home", "Memory lane card", "Two-tap game start",
             "Tonight's plan card", "Mood check-in on home"],
    "push": ["Bedtime nudge at 10:30 pm", "Partner-is-online push", "Streak-saver push", "Good-night prompt",
             "Question-of-the-day push", "Partner played, your turn push"],
}
WHY = {
    "onboarding": "fewer steps stand between install and the first shared moment",
    "invite": "a clearer invite gets the partner into the app on day 0",
    "home": "an obvious next thing to do together brings couples back the next day",
    "push": "a well-timed nudge in the 9 pm to midnight window brings couples back the next day",
}

DEV_FAMILIES = ["clean_win", "clean_null", "clean_loss", "denominator_trap", "guardrail_loud", "srm_bug",
                "tracking_bug", "peeking"]
HOLDOUT_FAMILIES = DEV_FAMILIES + ["guardrail_quiet", "split_couples", "underpowered_win"]


def plan_per_arm(p1: float, rel_mwe: float, alpha: float = 0.05, power: float = 0.8) -> int:
    """Users per arm for a two-sided test of two proportions (normal approximation, no continuity)."""
    p2 = p1 * (1 + rel_mwe)
    pbar = (p1 + p2) / 2
    za, zb = norm.ppf(1 - alpha / 2), norm.ppf(power)
    n = (za * math.sqrt(2 * pbar * (1 - pbar)) + zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2
    return int(math.ceil(n))


@dataclass
class Design:
    family: str
    surface: str
    name: str
    primary: str               # the metric the team registered as primary
    itt_twin: str | None       # per-assigned version, when the primary is conditional
    guardrails: list[str]
    secondaries: list[str]
    mwe_rel: float
    shift: Shift
    plan_n: int
    days: int
    traffic: float             # actual enrolment per arm relative to plan
    split_couples: bool = False
    srm_crash: float = 0.0
    tracking_bug: float = 0.0
    peek: bool = False
    story: str = ""
    extra: dict = field(default_factory=dict)


def _rate(e: dict, metric: str) -> float:
    return e[MODEL_KEY[metric]]


def truth(base: Base, d: Design) -> dict:
    """True label from exact expected rates (the couple-level design, all assigned users)."""
    c = expected(base)
    t = expected(base, d.shift, srm_crash=d.srm_crash)
    prim = d.itt_twin or d.primary
    better = METRICS[prim][3]
    sign = 1 if better == "up" else -1
    improvement = sign * (_rate(t, prim) - _rate(c, prim))
    mwe_abs = d.mwe_rel * _rate(c, prim)
    guard = {}
    breached = []
    for g in d.guardrails:
        gs = 1 if METRICS[g][3] == "up" else -1
        harm = -gs * (_rate(t, g) - _rate(c, g))
        margin = MARGIN_REL[g] * _rate(c, g)
        guard[g] = {"control": _rate(c, g), "test": _rate(t, g), "harm": harm, "margin": margin}
        if harm > margin:
            breached.append(g)
    if improvement < -1e-9 or breached:
        cls = "harmful"
    elif improvement >= mwe_abs:
        cls = "winner"
    else:
        cls = "neutral"
    shown = {m: {"control": _rate(c, m), "test": _rate(t, m)} for m in
             dict.fromkeys([prim, d.primary, *d.guardrails, *d.secondaries])}
    return {"class": cls, "primary": prim, "improvement": improvement, "mwe_abs": mwe_abs,
            "guardrails": guard, "breached": breached, "rates": shown}


def _rel_target(base: Base, metric: str, rel: float) -> float:
    return rel * _rate(expected(base), metric)


def design(family: str, base: Base, rng: np.random.Generator) -> Design:
    """Draw one experiment of the given family."""
    if family in ("denominator_trap",):
        surface = "home"
    elif family == "tracking_bug":
        surface = "onboarding"
    elif family == "split_couples":
        surface = "invite"
    elif family in ("guardrail_loud",):
        surface = "push"
    elif family in ("guardrail_quiet", "underpowered_win"):
        surface = str(rng.choice(["home", "push"]))
    else:
        surface = str(rng.choice(list(SURFACES)))
    primary, guardrails, secondaries, direction = SURFACES[surface]
    guardrails, secondaries = list(guardrails), list(secondaries)
    mwe_rel = float(rng.uniform(0.05, 0.10) if primary == "act" else rng.uniform(0.04, 0.08))
    name = str(rng.choice(NAMES[surface]))
    days = int(rng.choice([7, 14], p=[0.3, 0.7]))
    traffic = float(rng.uniform(0.97, 1.08))
    itt_twin = None
    shift = Shift()
    kw: dict = {}
    story = ""

    if family in ("clean_win", "split_couples", "underpowered_win", "guardrail_quiet", "guardrail_loud"):
        if family == "guardrail_quiet":
            mwe_rel = float(rng.uniform(0.10, 0.14))
        k = float(rng.uniform(1.2, 2.2))
        shift = solve_shift(base, direction, primary, _rel_target(base, primary, mwe_rel * k))
        story = f"A real improvement: the true lift in {METRICS[primary][0]} is {k:.1f}x the minimum worthwhile effect."
    elif family == "clean_loss":
        k = float(rng.uniform(0.8, 2.0))
        shift = solve_shift(base, direction, primary, -_rel_target(base, primary, mwe_rel * k))
        story = f"A real loss: {METRICS[primary][0]} truly falls by {k:.1f}x the minimum worthwhile effect."
    elif family in ("clean_null", "peeking"):
        story = "No real effect on anything: the variant changes nothing users respond to."
    elif family == "denominator_trap":
        name = str(rng.choice(["Pair before play", "Partner code before the first game", "Mandatory pairing step"]))
        primary, itt_twin = "d1_act", "d1"
        secondaries = ["d7"]
        c = expected(base)
        for _ in range(500):
            s = Shift(onb_low=float(rng.uniform(0.3, 1.2)), inv=float(rng.uniform(0.0, 0.8)),
                      d1=float(rng.uniform(0.0, 0.12)))
            t = expected(base, s)
            cond = t["d1_given_act"] / c["d1_given_act"] - 1
            itt = t["d1"] - c["d1"]
            act_rel = t["act"] / c["act"] - 1
            if cond >= 0.03 and itt <= -0.25 * mwe_rel * c["d1"] and -0.12 <= act_rel <= -0.02:
                shift = s
                break
        else:
            raise RuntimeError("no denominator-trap draw")
        story = (f"Pairing before the first game filters out less committed installers. D1 retention of activated "
                 f"couples rises {cond:+.1%} (relative), while D1 retention per installer changes by "
                 f"{itt * 100:+.2f} points and activation by {act_rel:+.1%}.")
    elif family == "srm_bug":
        kw["srm_crash"] = float(rng.uniform(0.25, 0.6))
        story = (f"The test build crashes on launch for {kw['srm_crash']:.0%} of old-Android installers before "
                 f"the exposure event fires. They vanish from the test arm's data, and they were its least "
                 f"committed users.")
    elif family == "tracking_bug":
        k = float(rng.uniform(0.3, 1.0))
        shift = solve_shift(base, Shift(shared=1.0), "act", -_rel_target(base, "act", mwe_rel * k))
        kw["tracking_bug"] = float(rng.uniform(0.01, 0.10))
        story = (f"The new solo warm-up game sends shared_game_completed for {kw['tracking_bug']:.0%} of onboarded "
                 f"test users, so solo players count as activated couples. Real activation falls slightly "
                 f"({k:.1f}x the minimum worthwhile effect).")

    if family == "guardrail_loud":
        name = str(rng.choice(["Three bedtime nudges", "Hourly evening reminders", "Partner-is-waiting pushes"]))
        push_k, un_k = float(rng.uniform(2.5, 5.0)), float(rng.uniform(1.5, 3.0))
        shift = combine(shift, solve_shift(base, Shift(push=1.0), "push",
                                           push_k * MARGIN_REL["push"] * _rate(expected(base), "push")))
        un_target = un_k * MARGIN_REL["un"] * _rate(expected(base), "un")
        base_un = _rate(expected(base, shift), "un") - _rate(expected(base), "un")
        shift = combine(shift, solve_shift(base, Shift(un=1.0), "un", un_target - base_un))
        story += (f" It also raises push disables by {push_k:.1f}x and uninstalls by {un_k:.1f}x their margins.")
    if family == "guardrail_quiet":
        g = "crash" if surface == "home" else "un"
        name = {"home": "Animated home background", "push": "Rich-media bedtime push"}[surface]
        k = float(rng.uniform(1.1, 1.5))
        target = k * MARGIN_REL[g] * _rate(expected(base), g)
        already = _rate(expected(base, shift), g) - _rate(expected(base), g)
        shift = combine(shift, solve_shift(base, Shift(**{g: 1.0}), g, target - already))
        story += (f" It also raises {METRICS[g][0].lower()} by {k:.2f}x the margin: just past it, and often too "
                  f"little for a test this size to flag as significant.")
    if family == "split_couples":
        name = "Couple quiz at partner sign-up"
        kw["split_couples"] = True
        story += (" But each partner was randomised on their own, so about half the couples were split across arms "
                  "and the quiz only works when both partners have it.")

    if family == "denominator_trap":
        # The team sized the test for the metric it registered: retention among activated couples
        c = expected(base)
        plan_n = int(math.ceil(plan_per_arm(c["d1_given_act"], mwe_rel) / c["act"]))
    else:
        plan_n = plan_per_arm(_rate(expected(base), primary), mwe_rel)
    if family == "underpowered_win":
        frac = float(rng.uniform(0.25, 0.45))
        plan_n = int(plan_n * frac)
        story += f" The team ran it at {frac:.0%} of the sample this effect needs."
    if family == "peeking":
        days = 14
    return Design(family=family, surface=surface, name=name, primary=primary, itt_twin=itt_twin,
                  guardrails=guardrails, secondaries=secondaries, mwe_rel=mwe_rel, shift=shift, plan_n=plan_n,
                  days=days, traffic=traffic, story=story.strip(), peek=family == "peeking", **kw)


EXPECTED_CLASS = {
    "clean_win": "winner", "clean_null": "neutral", "clean_loss": "harmful", "denominator_trap": "harmful",
    "guardrail_loud": "harmful", "srm_bug": "harmful", "tracking_bug": "harmful", "peeking": "neutral",
    "guardrail_quiet": "harmful", "split_couples": "winner", "underpowered_win": "winner",
}
DATA_PROBLEM = {"srm_bug", "tracking_bug", "split_couples"}
