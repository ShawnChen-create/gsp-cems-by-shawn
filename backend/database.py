import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from .parser import POLLUTANTS, build_effective_latest

DB_PATH = Path(os.getenv("GSP_CEMS_DB", "data/gsp_cems.db"))


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cems_observations (
                date TEXT NOT NULL,
                pol_no TEXT NOT NULL,
                time TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                pollutant_key TEXT NOT NULL,
                value REAL,
                standard REAL,
                hourly_avg INTEGER NOT NULL DEFAULT 0,
                raw TEXT,
                source TEXT NOT NULL DEFAULT 'unknown',
                imported_at TEXT NOT NULL,
                PRIMARY KEY (date, pol_no, time, pollutant_key)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cems_imports (
                date TEXT NOT NULL,
                pol_no TEXT NOT NULL,
                source TEXT NOT NULL,
                row_count INTEGER NOT NULL DEFAULT 0,
                imported_at TEXT NOT NULL,
                PRIMARY KEY (date, pol_no, source)
            )
            """
        )
        conn.commit()


def clear_day(date: str, source: str | None = None) -> None:
    with get_conn() as conn:
        if source:
            conn.execute("DELETE FROM cems_observations WHERE date=? AND source=?", (date, source))
            conn.execute("DELETE FROM cems_imports WHERE date=? AND source=?", (date, source))
        else:
            conn.execute("DELETE FROM cems_observations WHERE date=?", (date,))
            conn.execute("DELETE FROM cems_imports WHERE date=?", (date,))
        conn.commit()


def upsert_parsed_result(parsed: Dict[str, Any], source: str = "offline") -> int:
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    date = parsed.get("date")
    pol_no = parsed.get("pol_no")
    rows = parsed.get("history") or parsed.get("rows") or []
    inserted = 0
    with get_conn() as conn:
        for row in rows:
            time = row.get("time")
            timestamp = row.get("timestamp") or f"{date} {time}"
            values = row.get("values") or {}
            if not time:
                continue
            for pollutant in POLLUTANTS:
                key = pollutant["key"]
                v = values.get(key) or {}
                conn.execute(
                    """
                    INSERT INTO cems_observations
                    (date, pol_no, time, timestamp, pollutant_key, value, standard, hourly_avg, raw, source, imported_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, pol_no, time, pollutant_key) DO UPDATE SET
                        value=excluded.value,
                        standard=excluded.standard,
                        hourly_avg=excluded.hourly_avg,
                        raw=excluded.raw,
                        source=excluded.source,
                        imported_at=excluded.imported_at
                    """,
                    (
                        date,
                        pol_no,
                        time,
                        timestamp,
                        key,
                        v.get("value"),
                        v.get("standard"),
                        1 if v.get("hourly_avg") else 0,
                        v.get("raw", ""),
                        source,
                        now,
                    ),
                )
                inserted += 1
        conn.execute(
            """
            INSERT INTO cems_imports (date, pol_no, source, row_count, imported_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date, pol_no, source) DO UPDATE SET
                row_count=excluded.row_count,
                imported_at=excluded.imported_at
            """,
            (date, pol_no, source, len(rows), now),
        )
        conn.commit()
    return inserted


def _empty_result(date: str, pol_no: str, message: str = "尚無快取資料") -> Dict[str, Any]:
    return {
        "ok": False,
        "date": date,
        "pol_no": pol_no,
        "latest": {"date": date, "time": None, "timestamp": None, "pol_no": pol_no, "values": {}},
        "history": [],
        "rows": [],
        "history_count": 0,
        "count": 0,
        "message": message,
    }


def load_cached_result(date: str, pol_no: str) -> Dict[str, Any]:
    init_db()
    with get_conn() as conn:
        rs = conn.execute(
            """
            SELECT * FROM cems_observations
            WHERE date=? AND pol_no=?
            ORDER BY time ASC, pollutant_key ASC
            """,
            (date, pol_no),
        ).fetchall()
    if not rs:
        return _empty_result(date, pol_no)

    by_time: Dict[str, Dict[str, Any]] = {}
    for r in rs:
        time = r["time"]
        if time not in by_time:
            by_time[time] = {
                "date": date,
                "time": time,
                "timestamp": r["timestamp"],
                "pol_no": pol_no,
                "values": {},
            }
        by_time[time]["values"][r["pollutant_key"]] = {
            "raw": r["raw"],
            "value": r["value"],
            "standard": r["standard"],
            "hourly_avg": bool(r["hourly_avg"]),
        }

    history = [by_time[t] for t in sorted(by_time.keys())]
    latest = build_effective_latest(history, {"values": {}, "time": None, "timestamp": None}, date, pol_no)
    return {
        "ok": True,
        "date": date,
        "pol_no": pol_no,
        "latest": latest,
        "history": history,
        "rows": history,
        "history_count": len(history),
        "count": len(history),
        "pollutants": POLLUTANTS,
    }


def load_cached_day(date: str, pols: List[str]) -> Dict[str, Any]:
    return {pol: load_cached_result(date, pol) for pol in pols}


def cache_stats(date: str | None = None) -> Dict[str, Any]:
    init_db()
    with get_conn() as conn:
        if date:
            rows = conn.execute(
                """
                SELECT pol_no, source, COUNT(*) AS cell_count, COUNT(DISTINCT time) AS row_count, MAX(imported_at) AS imported_at
                FROM cems_observations WHERE date=? GROUP BY pol_no, source ORDER BY pol_no
                """,
                (date,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT pol_no, source, COUNT(*) AS cell_count, COUNT(DISTINCT date || ' ' || time) AS row_count, MAX(imported_at) AS imported_at
                FROM cems_observations GROUP BY pol_no, source ORDER BY pol_no
                """
            ).fetchall()
    return {f"{r['pol_no']}_{r['source']}": dict(r) for r in rows}
