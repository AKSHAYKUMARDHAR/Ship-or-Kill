"""The engine's statistics (site/shiporkill.js) against scipy and statsmodels."""
import json
import math
import subprocess
from pathlib import Path

import pytest
from scipy.stats import chisquare, norm
from statsmodels.stats.proportion import proportions_ztest

from sim.families import plan_per_arm

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def js():
    out = subprocess.run(["node", str(ROOT / "tests" / "dump_stats.js")], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_normal_quantiles(js):
    for p, x in js["normInv"]:
        assert x == pytest.approx(norm.ppf(p), abs=2e-7)


def test_normal_tails(js):
    for z, sf in js["normSf"]:
        assert sf == pytest.approx(norm.sf(z), rel=2e-6, abs=1e-12)


def test_sample_size_matches_the_python_planner(js):
    for p, r, n in js["perArm"]:
        assert n == plan_per_arm(p, r)


def test_srm_matches_chisquare(js):
    for c, t, s, p in js["srm"]:
        n = c + t
        expect = chisquare([c, t], [n * (1 - s), n * s]).pvalue
        assert p == pytest.approx(expect, rel=1e-5, abs=1e-12)


def test_agresti_caffo_interval(js):
    for xc, nc, xt, nt, lo, hi, p in js["propDiff"]:
        ac, at = (xc + 1) / (nc + 2), (xt + 1) / (nt + 2)
        se = math.sqrt(ac * (1 - ac) / (nc + 2) + at * (1 - at) / (nt + 2))
        d = at - ac
        assert lo == pytest.approx(d - 1.959963984540054 * se, abs=1e-12)
        assert hi == pytest.approx(d + 1.959963984540054 * se, abs=1e-12)
        assert p == pytest.approx(2 * norm.sf(abs(d / se)), rel=1e-5)


def test_pooled_z_matches_statsmodels(js):
    for xc, nc, xt, nt, p in js["pooled"]:
        expect = proportions_ztest([xt, xc], [nt, nc])[1]
        assert p == pytest.approx(expect, rel=1e-5)
