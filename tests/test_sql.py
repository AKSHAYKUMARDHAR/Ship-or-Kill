"""sql/readout.sql on a hand-built event log with known answers."""
import pandas as pd

from sim.readout import counts

H, D = 3600, 86400


def ev(rows):
    df = pd.DataFrame(rows, columns=["distinct_id", "event", "ts", "variant", "segment", "partner_variant"])
    return df.astype({"distinct_id": "int64", "ts": "float64"})


def test_windows_maturity_and_audits():
    x = "$feature_flag_called"
    rows = [
        # 1: control, activated on day 0, back on day 1 and day 7
        (1, x, 0, "control", "ios", None), (1, "partner_joined", 2 * H, None, None, "control"),
        (1, "shared_game_completed", 3 * H, None, None, None), (1, "app_opened", D + H, None, None, None),
        (1, "app_opened", 7 * D + H, None, None, None),
        # 2: control, shared game after 24 h (not D0 activation), opened at 47 h (D1), uninstalled at 30 h
        (2, x, 0, "control", "ios", None), (2, "partner_joined", 20 * H, None, None, "test"),
        (2, "shared_game_completed", 25 * H, None, None, None), (2, "app_opened", 47 * H, None, None, None),
        (2, "app_uninstalled", 30 * H, None, None, None),
        # 3: test, opened at 49 h (not D1), shared game with no partner (tracking audit)
        (3, x, 0, "test", "android_old", None), (3, "shared_game_completed", H, None, None, None),
        (3, "app_opened", 49 * H, None, None, None),
        # 4: test, exposed late: D1 window not closed at the cutoff, so not in D1 counts
        (4, x, 9 * D, "test", "android_new", None), (4, "app_opened", 9 * D + 2 * H, None, None, None),
        # 5: exposed to both arms: out of every metric, counted under its first arm
        (5, x, 0, "test", "ios", None), (5, x, 2 * H, "control", "ios", None),
    ]
    c = counts(ev(rows), 10 * D)
    ctl, tst = c["arms"]["control"], c["arms"]["test"]
    assert ctl["assigned"] == 2 and tst["assigned"] == 2
    assert ctl["activated_d0"] == 1 and ctl["d0_eligible"] == 2
    assert ctl["retained_d1"] == 2 and ctl["d1_eligible"] == 2
    assert tst["retained_d1"] == 0 and tst["d1_eligible"] == 1          # user 4 not mature
    assert tst["d0_eligible"] == 2 and tst["activated_d0"] == 1          # user 3's fake shared game counts
    assert ctl["d7_eligible"] == 2 and ctl["retained_d7"] == 1           # exposed at t=0, cutoff day 10
    assert ctl["uninstalled_48h"] == 1
    assert ctl["d1_activated"] == 1 and ctl["d1_activated_retained"] == 1
    assert tst["shared_without_partner"] == 1 and ctl["shared_without_partner"] == 0
    assert ctl["partner_other_arm"] == 1 and ctl["joined_any"] == 2
    assert tst["both_arms"] == 1 and ctl["both_arms"] == 0
    segs = {s["name"]: s for s in c["segments"]}
    assert segs["ios"]["control"] == 2 and segs["android_old"]["test"] == 1
    assert [d["name"] for d in c["days"]] == ["1", "10"]
