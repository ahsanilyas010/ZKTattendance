"""SQLite outbox. Punches are written here *before* any upload attempt, so an internet outage
(or an agent crash) never loses data: they stay queued until the cloud acknowledges them."""
from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Punch:
    device_id: int
    device_user_id: str
    punched_at: str  # ISO-8601 with UTC offset
    verify_method: str | None = None
    punch_type: int | None = None


class Store:
    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        self._db.executescript(
            """
            pragma journal_mode = wal;
            pragma synchronous = full;
            create table if not exists outbox (
              id integer primary key autoincrement,
              device_id integer not null, user_id text not null, ts text not null,
              verify text, ptype integer,
              unique (device_id, user_id, ts)
            );
            create table if not exists meta (key text primary key, value text not null);
            """
        )

    def enqueue(self, punches: list[Punch]) -> int:
        """Queue punches, ignoring ones already queued. Returns how many were new."""
        with self._lock, self._db:
            before = self._db.total_changes
            self._db.executemany(
                "insert or ignore into outbox (device_id, user_id, ts, verify, ptype) values (?,?,?,?,?)",
                [(p.device_id, p.device_user_id, p.punched_at, p.verify_method, p.punch_type) for p in punches],
            )
            return self._db.total_changes - before

    def pending(self, limit: int = 500) -> list[tuple[int, Punch]]:
        with self._lock:
            rows = self._db.execute(
                "select id, device_id, user_id, ts, verify, ptype from outbox order by id limit ?", (limit,)
            ).fetchall()
        return [(r[0], Punch(r[1], r[2], r[3], r[4], r[5])) for r in rows]

    def delete(self, ids: list[int]) -> None:
        with self._lock, self._db:
            self._db.executemany("delete from outbox where id = ?", [(i,) for i in ids])

    def depth(self) -> int:
        with self._lock:
            return self._db.execute("select count(*) from outbox").fetchone()[0]

    def get(self, key: str) -> str | None:
        with self._lock:
            row = self._db.execute("select value from meta where key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set(self, key: str, value: str) -> None:
        with self._lock, self._db:
            self._db.execute("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", (key, value))

    def close(self) -> None:
        self._db.close()
