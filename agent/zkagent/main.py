from __future__ import annotations

import argparse
import logging
import logging.handlers
import signal
import socket
import sys
import threading
import time

from . import __version__
from .agent import Agent
from .cloud import Cloud, CloudError
from .config import ConfigError, load
from .device import ZkDevice
from .store import Store

log = logging.getLogger("zkagent")


def _setup_logging(data_dir, verbose: bool) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    root = logging.getLogger("zkagent")
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    for h in (logging.handlers.RotatingFileHandler(data_dir / "agent.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8"), logging.StreamHandler()):
        h.setFormatter(fmt)
        root.addHandler(h)


def build(config_path: str) -> Agent:
    cfg = load(config_path)
    return Agent(cfg, Store(cfg.data_dir / "queue.db"), Cloud(cfg.cloud_url, cfg.api_key, cfg.request_timeout_sec),
                 lambda ip, port, pw, t: ZkDevice(ip, port, pw, t), hostname=socket.gethostname())


def run(config_path: str, once: bool, verbose: bool) -> int:
    try:
        agent = build(config_path)
    except ConfigError as e:
        print(f"Config problem: {e}", file=sys.stderr)
        return 2
    _setup_logging(agent.cfg.data_dir, verbose)
    log.info("zkagent %s starting; queue holds %d punch(es)", __version__, agent.store.depth())
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        started = time.monotonic()
        try:
            wait = agent.cycle()
        except Exception:  # never let one bad cycle kill the service
            log.exception("cycle failed")
            wait = 30
        if once:
            return 0
        stop.wait(max(1.0, wait - (time.monotonic() - started)))
    log.info("stopping")
    return 0


def check(config_path: str) -> int:
    """Setup helper: verifies the key, the cloud connection and every terminal, in plain language."""
    try:
        cfg = load(config_path)
    except ConfigError as e:
        print(f"FAIL  config: {e}")
        return 2
    print(f"OK    config read ({cfg.cloud_url})")
    try:
        conf = Cloud(cfg.cloud_url, cfg.api_key, cfg.request_timeout_sec).get_config()
    except CloudError as e:
        print(f"FAIL  cloud: {e}")
        return 1
    print(f"OK    cloud reachable, key accepted, site time zone {conf.get('timezone')}")
    devices = conf.get("devices", [])
    if not devices:
        print("WARN  no devices configured yet. Add the terminal under Devices & sync in the dashboard.")
    bad = 0
    for d in devices:
        try:
            dev = ZkDevice(d["ip"], int(d["port"]), int(d.get("comm_password") or 0), cfg.device_timeout_sec)
            info = dev.info()
            dev.close()
            print(f"OK    {d['name']} {d['ip']}:{d['port']} - {info.get('model')}, serial {info.get('serial')}, {info.get('enrolled_count')} people")
        except Exception as e:
            bad += 1
            print(f"FAIL  {d['name']} {d['ip']}:{d['port']} - {e.__class__.__name__}: {e}")
    return 1 if bad else 0


def cli() -> None:
    p = argparse.ArgumentParser(prog="zkagent", description="ZKTeco attendance sync agent")
    p.add_argument("command", choices=["run", "once", "check"], nargs="?", default="run")
    p.add_argument("-c", "--config", default="agent.toml")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args()
    if a.command == "check":
        sys.exit(check(a.config))
    sys.exit(run(a.config, once=a.command == "once", verbose=a.verbose))
