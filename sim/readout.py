"""Run the SQL templates on an event log and assemble the readout counts the engine reads."""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd

SQL_DIR = Path(__file__).resolve().parent.parent / "sql"
READOUT_SQL = (SQL_DIR / "readout.sql").read_text(encoding="utf-8")
SEGMENTS_SQL = (SQL_DIR / "segments.sql").read_text(encoding="utf-8")


def counts(events: pd.DataFrame, cutoff: float) -> dict:
    con = duckdb.connect()
    con.register("events", events)
    arms = con.execute(READOUT_SQL, {"cutoff": cutoff}).df().set_index("variant")
    cuts = con.execute(SEGMENTS_SQL, {"cutoff": cutoff}).df()
    con.close()
    arm = {v: {k: int(x) for k, x in arms.loc[v].items()} for v in ("control", "test")}
    segs, days = [], []
    for (cut, level), g in cuts.groupby(["cut", "level"], sort=False):
        row = {"name": level, **{v: int(g.loc[g.variant == v, "assigned"].sum()) for v in ("control", "test")}}
        (segs if cut == "segment" else days).append(row)
    days.sort(key=lambda r: int(r["name"]))
    return {"arms": arm, "segments": segs, "days": days}
