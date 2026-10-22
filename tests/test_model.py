"""The exact expected rates (used for truth labels) against a large simulation of the same model."""
import numpy as np

from sim.model import Shift, calibrate, expected, simulate_users


def test_expected_rates_match_simulation():
    rng = np.random.default_rng(7)
    base, _ = calibrate(rng)
    shift = Shift(onb_low=0.6, inv=0.3, d1=0.05, push=0.4)
    exp = expected(base, shift)
    sim = simulate_users(rng, base, shift, 300_000)
    for k in ("act", "d1", "d7", "un", "push", "crash"):
        assert abs(sim[k].mean() - exp[k]) < 0.004, k
    assert abs(sim["d1"][sim["act"]].mean() - exp["d1_given_act"]) < 0.006


def test_split_couples_dilute_the_couple_effect():
    rng = np.random.default_rng(8)
    base, _ = calibrate(rng)
    shift = Shift(join=0.6, shared=0.3)
    full, half = expected(base, shift)["act"], expected(base, shift, couple_share=0.5)["act"]
    ctrl = expected(base)["act"]
    assert abs((half - ctrl) - (full - ctrl) / 2) < 0.003
    sim = simulate_users(rng, base, shift, 300_000, split_couples=True)
    assert abs(sim["act"].mean() - half) < 0.004
