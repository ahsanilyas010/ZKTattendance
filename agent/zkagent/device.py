"""Thin wrapper over pyzk (pure-Python ZKTeco protocol, port 4370). Read-only except for the
explicit set_user call used when an admin ticks "write this name to the terminal"."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

VERIFY = {0: "Password", 1: "Fingerprint", 2: "Card", 3: "Password", 4: "Card", 15: "Face"}


@dataclass(frozen=True)
class Record:
    user_id: str
    timestamp: datetime  # naive, in the device's local clock
    status: int
    punch: int


@dataclass(frozen=True)
class UserInfo:
    uid: int
    user_id: str
    name: str
    privilege: int = 0
    password: str = ""
    group_id: str = ""
    card: int = 0


class Device(Protocol):
    def info(self) -> dict: ...
    def records(self) -> list[Record]: ...
    def users(self) -> list[UserInfo]: ...
    def device_time(self) -> datetime: ...
    def write_user(self, uid: int, user_id: str, name: str, base: UserInfo | None) -> None: ...
    def close(self) -> None: ...


def verify_label(punch: int) -> str:
    return VERIFY.get(punch, f"Method {punch}")


class ZkDevice:
    """Opens a connection on construction; call close() when done."""

    def __init__(self, ip: str, port: int = 4370, password: int = 0, timeout: float = 10):
        from zk import ZK  # imported lazily so tests and `check` work without a device

        self._zk = ZK(ip, port=port, timeout=timeout, password=password, force_udp=False, ommit_ping=True)
        self._conn = self._zk.connect()

    def info(self) -> dict:
        c = self._conn
        out = {"serial": None, "model": None, "enrolled_count": None}
        for key, fn in (("serial", c.get_serialnumber), ("model", c.get_device_name)):
            try:
                out[key] = str(fn()).strip("\x00 ") or None
            except Exception:
                pass
        try:
            out["enrolled_count"] = len(self.users())
        except Exception:
            pass
        return out

    def records(self) -> list[Record]:
        return [Record(str(a.user_id), a.timestamp, int(a.status), int(a.punch)) for a in (self._conn.get_attendance() or [])]

    def users(self) -> list[UserInfo]:
        return [UserInfo(int(u.uid), str(u.user_id), str(u.name or "").strip(), int(u.privilege), str(u.password or ""), str(u.group_id or ""), int(u.card or 0))
                for u in (self._conn.get_users() or [])]

    def device_time(self) -> datetime:
        return self._conn.get_time()

    def write_user(self, uid: int, user_id: str, name: str, base: UserInfo | None) -> None:
        # Keep privilege/password/card of an existing user; only the display name changes.
        self._conn.set_user(
            uid=uid, name=name, privilege=base.privilege if base else 0, password=base.password if base else "",
            group_id=base.group_id if base else "", user_id=user_id, card=base.card if base else 0,
        )

    def close(self) -> None:
        try:
            self._conn.disconnect()
        except Exception:
            pass
