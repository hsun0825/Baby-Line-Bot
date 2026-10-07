"""SQLite 儲存。時間一律存成 UTC 的 Unix timestamp（秒）。"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER,
    value       REAL,
    unit        TEXT,
    detail      TEXT    NOT NULL DEFAULT '',
    user_id     TEXT,
    created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_chat_time ON records (chat_id, start_ts);
"""


@dataclass
class Record:
    id: int
    chat_id: str
    kind: str
    start: datetime
    end: datetime | None
    value: float | None
    unit: str | None
    detail: str
    user_id: str | None


def _ts(dt: datetime) -> int:
    return int(dt.timestamp())


def _dt(ts: int | None, tz) -> datetime | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(tz)


class Storage:
    def __init__(self, path: str, tz):
        self.tz = tz
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def _row(self, row: sqlite3.Row) -> Record:
        return Record(
            id=row["id"],
            chat_id=row["chat_id"],
            kind=row["kind"],
            start=_dt(row["start_ts"], self.tz),
            end=_dt(row["end_ts"], self.tz),
            value=row["value"],
            unit=row["unit"],
            detail=row["detail"],
            user_id=row["user_id"],
        )

    def add(self, chat_id: str, kind: str, start: datetime, *, end=None, value=None,
            unit=None, detail="", user_id=None) -> Record:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO records (chat_id, kind, start_ts, end_ts, value, unit, detail, user_id, created_ts)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))",
                (chat_id, kind, _ts(start), _ts(end) if end else None, value, unit, detail, user_id),
            )
            self._conn.commit()
            return self.get(cur.lastrowid)

    def get(self, record_id: int) -> Record | None:
        row = self._conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
        return self._row(row) if row else None

    def set_end(self, record_id: int, end: datetime) -> Record:
        with self._lock:
            self._conn.execute("UPDATE records SET end_ts = ? WHERE id = ?", (_ts(end), record_id))
            self._conn.commit()
        return self.get(record_id)

    def open_sleep(self, chat_id: str) -> Record | None:
        """最近一筆還沒結束的睡眠。"""
        row = self._conn.execute(
            "SELECT * FROM records WHERE chat_id = ? AND kind = 'sleep' AND end_ts IS NULL"
            " ORDER BY start_ts DESC LIMIT 1",
            (chat_id,),
        ).fetchone()
        return self._row(row) if row else None

    def last_of_kind(self, chat_id: str, kind: str) -> Record | None:
        row = self._conn.execute(
            "SELECT * FROM records WHERE chat_id = ? AND kind = ? ORDER BY start_ts DESC LIMIT 1",
            (chat_id, kind),
        ).fetchone()
        return self._row(row) if row else None

    def last_created(self, chat_id: str) -> Record | None:
        row = self._conn.execute(
            "SELECT * FROM records WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (chat_id,)
        ).fetchone()
        return self._row(row) if row else None

    def delete(self, record_id: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM records WHERE id = ?", (record_id,))
            self._conn.commit()

    def between(self, chat_id: str, start: datetime, end: datetime) -> list[Record]:
        """與 [start, end) 有重疊的記錄（睡眠可能從前一天開始）。"""
        rows = self._conn.execute(
            "SELECT * FROM records WHERE chat_id = ? AND start_ts < ?"
            " AND (start_ts >= ? OR (kind = 'sleep' AND (end_ts IS NULL OR end_ts > ?)))"
            " ORDER BY start_ts",
            (chat_id, _ts(end), _ts(start), _ts(start)),
        ).fetchall()
        return [self._row(r) for r in rows]

    def recent(self, chat_id: str, limit: int = 10) -> list[Record]:
        rows = self._conn.execute(
            "SELECT * FROM records WHERE chat_id = ? ORDER BY start_ts DESC LIMIT ?",
            (chat_id, limit),
        ).fetchall()
        return [self._row(r) for r in reversed(rows)]
