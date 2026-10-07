"""紀錄的儲存。時間一律存成 UTC 的 Unix timestamp（秒）。

- 有設定 DATABASE_URL（postgres://...）時使用 PostgreSQL，例如 Neon 免費方案。
  免費主機重啟會清空磁碟，資料放外部資料庫才不會不見。
- 否則使用本機 SQLite 檔案。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

COLUMNS = """
    chat_id     TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    start_ts    BIGINT  NOT NULL,
    end_ts      BIGINT,
    value       REAL,
    unit        TEXT,
    detail      TEXT    NOT NULL DEFAULT '',
    user_id     TEXT,
    created_ts  BIGINT  NOT NULL
"""
SQLITE_SCHEMA = f"CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, {COLUMNS})"
POSTGRES_SCHEMA = f"CREATE TABLE IF NOT EXISTS records (id BIGSERIAL PRIMARY KEY, {COLUMNS})"
INDEX = "CREATE INDEX IF NOT EXISTS idx_records_chat_time ON records (chat_id, start_ts)"


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
    def __init__(self, tz, *, path: str = "baby.db", url: str | None = None):
        self.tz = tz
        self._lock = threading.Lock()
        self._url = url
        self._pg_conn = None
        if url:
            import psycopg  # 只有用 Postgres 時才需要安裝

            self._psycopg = psycopg
            self._execute(POSTGRES_SCHEMA)
        else:
            self._conn = sqlite3.connect(path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._execute(SQLITE_SCHEMA)
        self._execute(INDEX)

    def _execute(self, sql: str, params=(), fetch: str | None = None):
        """執行 SQL。sql 用 ? 當參數佔位符號；fetch 為 None、"one" 或 "all"。"""
        with self._lock:
            if self._url:
                sql = sql.replace("?", "%s")
                try:
                    cur = self._pg().execute(sql, params)
                except self._psycopg.OperationalError:
                    # Neon 這類服務閒置一陣子會把連線關掉，重新連線再試一次
                    self._pg_conn = None
                    cur = self._pg().execute(sql, params)
                return cur.fetchone() if fetch == "one" else cur.fetchall() if fetch == "all" else None
            cur = self._conn.execute(sql, params)
            result = cur.fetchone() if fetch == "one" else cur.fetchall() if fetch == "all" else None
            self._conn.commit()
            return result

    def _pg(self):
        if self._pg_conn is None or self._pg_conn.closed:
            from psycopg.rows import dict_row

            self._pg_conn = self._psycopg.connect(self._url, autocommit=True, row_factory=dict_row)
        return self._pg_conn

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
        row = self._execute(
            "INSERT INTO records (chat_id, kind, start_ts, end_ts, value, unit, detail, user_id, created_ts)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (chat_id, kind, _ts(start), _ts(end) if end else None, value, unit, detail, user_id,
             int(time.time())),
            fetch="one",
        )
        return self.get(row["id"])

    def get(self, record_id: int) -> Record | None:
        row = self._execute("SELECT * FROM records WHERE id = ?", (record_id,), fetch="one")
        return self._row(row) if row else None

    def set_end(self, record_id: int, end: datetime) -> Record:
        self._execute("UPDATE records SET end_ts = ? WHERE id = ?", (_ts(end), record_id))
        return self.get(record_id)

    def open_sleep(self, chat_id: str) -> Record | None:
        """最近一筆還沒結束的睡眠。"""
        row = self._execute(
            "SELECT * FROM records WHERE chat_id = ? AND kind = 'sleep' AND end_ts IS NULL"
            " ORDER BY start_ts DESC LIMIT 1",
            (chat_id,),
            fetch="one",
        )
        return self._row(row) if row else None

    def last_of_kind(self, chat_id: str, kind: str) -> Record | None:
        row = self._execute(
            "SELECT * FROM records WHERE chat_id = ? AND kind = ? ORDER BY start_ts DESC LIMIT 1",
            (chat_id, kind),
            fetch="one",
        )
        return self._row(row) if row else None

    def last_created(self, chat_id: str) -> Record | None:
        row = self._execute(
            "SELECT * FROM records WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (chat_id,), fetch="one"
        )
        return self._row(row) if row else None

    def delete(self, record_id: int) -> None:
        self._execute("DELETE FROM records WHERE id = ?", (record_id,))

    def between(self, chat_id: str, start: datetime, end: datetime) -> list[Record]:
        """與 [start, end) 有重疊的記錄（睡眠可能從前一天開始）。"""
        rows = self._execute(
            "SELECT * FROM records WHERE chat_id = ? AND start_ts < ?"
            " AND (start_ts >= ? OR (kind = 'sleep' AND (end_ts IS NULL OR end_ts > ?)))"
            " ORDER BY start_ts",
            (chat_id, _ts(end), _ts(start), _ts(start)),
            fetch="all",
        )
        return [self._row(r) for r in rows]

    def recent(self, chat_id: str, limit: int = 10) -> list[Record]:
        rows = self._execute(
            "SELECT * FROM records WHERE chat_id = ? ORDER BY start_ts DESC LIMIT ?",
            (chat_id, limit),
            fetch="all",
        )
        return [self._row(r) for r in reversed(rows)]
