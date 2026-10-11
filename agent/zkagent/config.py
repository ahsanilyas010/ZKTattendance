from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    cloud_url: str
    api_key: str
    data_dir: Path
    initial_backfill_days: int = 90
    request_timeout_sec: float = 20
    device_timeout_sec: float = 10


def load(path: str | Path) -> Config:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}. Copy agent.toml.example to agent.toml and fill it in.")
    try:
        raw = tomllib.loads(p.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{p} is not valid TOML: {e}") from e
    url = str(raw.get("cloud_url", "")).strip().rstrip("/")
    key = str(raw.get("api_key", "")).strip()
    if not url.startswith(("http://", "https://")):
        raise ConfigError("cloud_url must start with https:// (copy it from the dashboard).")
    if not key.startswith("zka_"):
        raise ConfigError("api_key looks wrong. It should start with zka_ (create one in the dashboard).")
    data_dir = Path(raw.get("data_dir", "data"))
    if not data_dir.is_absolute():
        data_dir = (p.resolve().parent / data_dir)
    return Config(
        cloud_url=url, api_key=key, data_dir=data_dir,
        initial_backfill_days=int(raw.get("initial_backfill_days", 90)),
        request_timeout_sec=float(raw.get("request_timeout_sec", 20)),
        device_timeout_sec=float(raw.get("device_timeout_sec", 10)),
    )
