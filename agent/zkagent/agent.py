"""One polling cycle: pull from every terminal into the local outbox, answer dashboard commands,
push names to terminals when asked, upload the outbox, report health.

Design rule: reading terminals and uploading to the cloud are independent. If the internet is
down the agent keeps pulling punches into SQLite and uploads them, with backoff, once it returns."""
from __future__ import annotations

import json
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from . import __version__
from .cloud import Cloud, CloudError
from .config import Config
from .device import Device, Record, UserInfo, verify_label
from .store import Punch, Store

log = logging.getLogger("zkagent")

DeviceFactory = Callable[[str, int, int, float], Device]
MAX_BATCHES_PER_CYCLE = 20  # 10k punches; keeps device polling responsive during a large backfill


class Backoff:
    """Exponential backoff for cloud uploads: 2s, 4s, ... capped at 5 minutes."""

    def __init__(self, base: float = 2, cap: float = 300, jitter: float = 0.2, clock: Callable[[], float] = time.monotonic):
        self.base, self.cap, self.jitter, self.clock = base, cap, jitter, clock
        self.failures = 0
        self.not_before = 0.0

    def ready(self) -> bool:
        return self.clock() >= self.not_before

    def fail(self) -> float:
        self.failures += 1
        delay = min(self.cap, self.base * (2 ** (self.failures - 1)))
        delay *= 1 + random.uniform(-self.jitter, self.jitter) if self.jitter else 1
        self.not_before = self.clock() + delay
        return delay

    def ok(self) -> None:
        self.failures = 0
        self.not_before = 0.0


def trim_name(name: str, limit: int = 24) -> str:
    """Terminals store names in a fixed-width field; cut on a character boundary."""
    return name.encode("utf-8")[:limit].decode("utf-8", "ignore").strip()


class Agent:
    def __init__(self, cfg: Config, store: Store, cloud: Cloud, device_factory: DeviceFactory,
                 hostname: str = "", now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self.cfg, self.store, self.cloud, self.open_device, self.now = cfg, store, cloud, device_factory, now
        self.hostname = hostname
        self.backoff = Backoff()
        self.last_error: str | None = None
        self._cmd_results: list[dict] = []
        self._enrolled: set[int] = set()
        self._cache = Path(cfg.data_dir) / "config-cache.json"

    # ------------------------------------------------------------------ config
    def load_config(self) -> dict | None:
        try:
            conf = self.cloud.get_config()
            self._cache.parent.mkdir(parents=True, exist_ok=True)
            self._cache.write_text(json.dumps(conf), encoding="utf-8")
            self.last_error = None
            return conf
        except CloudError as e:
            self.last_error = str(e)
            log.warning("cannot fetch config: %s", e)
            if e.status == 401:
                return None
        # Offline: keep polling terminals with the last known settings so no punches are missed.
        if self._cache.exists():
            try:
                return json.loads(self._cache.read_text(encoding="utf-8"))
            except ValueError:
                log.error("config cache is unreadable")
        return None

    # ------------------------------------------------------------------ one terminal
    def _to_punches(self, dev_id: int, recs: list[Record], tz: ZoneInfo) -> list[Punch]:
        """Keep only records not seen before.

        The mark is the newest timestamp seen plus the users already queued at exactly that second,
        so two people punching in the same second are never confused with a re-read."""
        key = f"hwm:{dev_id}"
        stored = self.store.get(key)
        seen_at_mark: set[str] = set(json.loads(self.store.get(key + ":users") or "[]"))
        mark = datetime.fromisoformat(stored) if stored else None
        if mark is None and self.cfg.initial_backfill_days > 0:
            floor = self.now() - timedelta(days=self.cfg.initial_backfill_days)
        else:
            floor = datetime.min.replace(tzinfo=timezone.utc)
        horizon = self.now() + timedelta(days=1)
        fresh: list[tuple[datetime, Record]] = []
        for r in recs:
            at = r.timestamp.replace(tzinfo=tz)  # the terminal's clock is local wall time
            if at.year < 2015 or at > horizon:
                continue  # terminal clock was reset or is wrong; do not poison the data
            if at < floor:
                continue
            if mark is not None and (at < mark or (at == mark and r.user_id in seen_at_mark)):
                continue
            fresh.append((at, r))
        if fresh:
            newest = max(at for at, _ in fresh)
            users = {r.user_id for at, r in fresh if at == newest}
            if mark is not None and newest == mark:
                users |= seen_at_mark
            self.store.set(key, newest.isoformat())
            self.store.set(key + ":users", json.dumps(sorted(users)))
        return [Punch(dev_id, r.user_id, at.isoformat(), verify_label(r.status), r.punch) for at, r in fresh]

    def _poll_device(self, d: dict, tz: ZoneInfo, conf: dict) -> dict:
        status = {"device_id": d["id"], "reachable": False}
        dev = None
        try:
            dev = self.open_device(d["ip"], int(d["port"]), int(d.get("comm_password") or 0), self.cfg.device_timeout_sec)
            info = dev.info()
            drift = int((dev.device_time() - self.now().astimezone(tz).replace(tzinfo=None)).total_seconds())
            added = self.store.enqueue(self._to_punches(d["id"], dev.records(), tz))
            if added:
                log.info("%s: %d new punch(es) queued", d["name"], added)
            status.update(reachable=True, serial=info.get("serial"), model=info.get("model"),
                          enrolled_count=info.get("enrolled_count"), clock_drift_sec=drift)
            for c in [c for c in conf.get("commands", []) if c["device_id"] == d["id"]]:
                self._run_command(c, d, dev, info, drift)
            self._push_enrollments(conf.get("enrollments", []), d, dev)
        except Exception as e:  # unreachable, timeout, protocol error...
            status["error"] = f"{e.__class__.__name__}: {e}"[:300]
            log.warning("%s (%s:%s): %s", d["name"], d["ip"], d["port"], status["error"])
        finally:
            if dev:
                dev.close()
        return status

    def _run_command(self, c: dict, d: dict, dev: Device, info: dict, drift: int) -> None:
        try:
            if c["kind"] == "test_connection":
                msg = f"Connected. {info.get('model') or 'Terminal'}, serial {info.get('serial') or '?'}, {info.get('enrolled_count', '?')} people enrolled, clock off by {abs(drift)}s."
            elif c["kind"] == "sync_users":
                users = [{"user_id": u.user_id, "name": u.name} for u in dev.users() if u.user_id]
                r = self.cloud.post_users(d["id"], users)
                msg = f"Imported {r.get('created', 0)} new people ({r.get('already_present', 0)} were already in the directory)."
            else:
                raise ValueError(f"unknown command {c['kind']}")
            self._cmd_results.append({"id": c["id"], "ok": True, "result": msg})
        except Exception as e:
            self._cmd_results.append({"id": c["id"], "ok": False, "result": f"{e.__class__.__name__}: {e}"[:300]})

    def _push_enrollments(self, items: list[dict], d: dict, dev: Device) -> None:
        if not items:
            return
        users: list[UserInfo] = dev.users()
        by_id = {u.user_id: u for u in users}
        next_uid = max([u.uid for u in users], default=0) + 1
        for it in items:
            try:
                base = by_id.get(it["device_user_id"])
                uid = base.uid if base else next_uid
                dev.write_user(uid, it["device_user_id"], trim_name(it["name"]), base)
                if not base:
                    next_uid += 1
                self._enrolled.add(it["employee_id"])
                log.info("%s: wrote %s (ID %s) to terminal", d["name"], it["name"], it["device_user_id"])
            except Exception as e:
                log.warning("%s: could not write %s: %s", d["name"], it["name"], e)

    # ------------------------------------------------------------------ upload
    def flush(self) -> None:
        if not self.backoff.ready():
            return
        for _ in range(MAX_BATCHES_PER_CYCLE):
            batch = self.store.pending(500)
            if not batch:
                break
            try:
                self.cloud.post_punches([p for _, p in batch])
            except CloudError as e:
                delay = self.backoff.fail()
                self.last_error = str(e)
                log.warning("upload failed (%s); %d punch(es) stay queued, retrying in %.0fs", e, self.store.depth(), delay)
                return
            self.store.delete([i for i, _ in batch])
            self.backoff.ok()

    def heartbeat(self, statuses: list[dict]) -> None:
        body = {
            "version": __version__, "hostname": self.hostname, "queue_depth": self.store.depth(),
            "last_error": self.last_error, "devices": statuses,
            "command_results": self._cmd_results, "enrolled_employee_ids": sorted(self._enrolled),
        }
        try:
            self.cloud.post_heartbeat(body)
            self._cmd_results, self._enrolled = [], set()  # only forget once the cloud has them
        except CloudError as e:
            self.last_error = str(e)
            log.warning("heartbeat failed: %s", e)

    # ------------------------------------------------------------------ cycle
    def cycle(self) -> float:
        """Run one pass and return how many seconds to wait before the next."""
        conf = self.load_config()
        if not conf:
            return 30
        tz = ZoneInfo(conf.get("timezone", "UTC"))
        statuses = [self._poll_device(d, tz, conf) for d in conf.get("devices", []) if d.get("enabled", True)]
        self.flush()
        self.heartbeat(statuses)
        return max(5, int(conf.get("poll_interval_sec", 30)))
