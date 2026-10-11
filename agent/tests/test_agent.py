import json
from datetime import datetime, timedelta, timezone

import pytest

from zkagent.agent import Agent, Backoff, trim_name
from zkagent.cloud import CloudError
from zkagent.config import Config, ConfigError, load
from zkagent.device import Record, UserInfo
from zkagent.store import Punch, Store

NOW = datetime(2026, 10, 12, 4, 30, tzinfo=timezone.utc)  # 09:30 in Karachi


class FakeDevice:
    def __init__(self, records=(), users=(), clock=datetime(2026, 10, 12, 9, 30)):
        self._records, self._users, self.clock = list(records), list(users), clock
        self.written, self.closed = [], False

    def info(self):
        return {"serial": "SN1", "model": "SpeedFace", "enrolled_count": len(self._users)}

    def records(self): return list(self._records)
    def users(self): return list(self._users)
    def device_time(self): return self.clock
    def write_user(self, uid, user_id, name, base): self.written.append((uid, user_id, name, base))
    def close(self): self.closed = True


class FakeCloud:
    def __init__(self, conf):
        self.conf, self.online = conf, True
        self.received, self.heartbeats, self.post_calls, self.users_posted = [], [], 0, []

    def _guard(self):
        if not self.online:
            raise CloudError("cannot reach cloud: ConnectionError")

    def get_config(self): self._guard(); return json.loads(json.dumps(self.conf))
    def post_punches(self, punches):
        self.post_calls += 1; self._guard(); self.received += punches; return len(punches)
    def post_heartbeat(self, body): self._guard(); self.heartbeats.append(body)
    def post_users(self, device_id, users): self._guard(); self.users_posted.append((device_id, users)); return {"created": len(users), "already_present": 0}


def conf(**over):
    base = {"timezone": "Asia/Karachi", "poll_interval_sec": 30, "devices": [{"id": 1, "name": "Front", "ip": "10.0.0.5", "port": 4370, "comm_password": 0, "enabled": True}],
            "enrollments": [], "commands": []}
    base.update(over)
    return base


def make(tmp_path, cloud, devices, backfill=90, now=NOW):
    cfg = Config("https://x", "zka_k", tmp_path, initial_backfill_days=backfill)
    store = Store(tmp_path / "q.db")
    agent = Agent(cfg, store, cloud, lambda ip, port, pw, t: devices[ip], hostname="PC", now=lambda: now)
    agent.backoff = Backoff(jitter=0, clock=lambda: agent_clock[0])
    return agent, store


agent_clock = [0.0]


@pytest.fixture(autouse=True)
def _reset_clock():
    agent_clock[0] = 0.0


def rec(uid, h, m, day=12, status=15, punch=0):
    return Record(uid, datetime(2026, 10, day, h, m), status, punch)


def test_punches_are_converted_to_site_timezone_queued_and_uploaded(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([rec("0042", 9, 0), rec("0007", 9, 5, status=1)])
    agent, store = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle()
    assert store.depth() == 0
    assert [(p.device_user_id, p.punched_at, p.verify_method) for p in cloud.received] == [
        ("0042", "2026-10-12T09:00:00+05:00", "Method 15" if False else "Face"),
        ("0007", "2026-10-12T09:05:00+05:00", "Fingerprint"),
    ]
    assert dev.closed
    hb = cloud.heartbeats[-1]
    assert hb["devices"][0]["reachable"] and hb["devices"][0]["serial"] == "SN1" and hb["queue_depth"] == 0


def test_internet_outage_loses_nothing_and_drains_afterwards(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([rec("1", 9, 0)])
    agent, store = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle()                       # healthy first cycle seeds the config cache
    cloud.online = False
    dev._records.append(rec("2", 9, 10))
    agent.cycle()
    dev._records.append(rec("3", 9, 20))
    agent.cycle()                       # still offline: still polling the terminal from cached config
    assert store.depth() == 2           # both new punches are safe on disk
    cloud.online = True
    agent_clock[0] = 10_000             # backoff elapsed
    agent.cycle()
    assert store.depth() == 0
    assert sorted(p.device_user_id for p in cloud.received) == ["1", "2", "3"]   # exactly once each


def test_backoff_stops_hammering_a_dead_cloud(tmp_path):
    cloud = FakeCloud(conf())
    agent, store = make(tmp_path, cloud, {"10.0.0.5": FakeDevice([rec("1", 9, 0)])})
    agent.cycle()
    cloud.online = False
    store.enqueue([Punch(1, "9", "2026-10-12T09:00:00+05:00")])
    calls = cloud.post_calls
    agent.flush(); agent.flush(); agent.flush()
    assert cloud.post_calls == calls + 1   # one attempt, then it waits
    agent_clock[0] += 3
    agent.flush()
    assert cloud.post_calls == calls + 2


def test_already_seen_records_are_not_requeued(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([rec("1", 9, 0)])
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle(); agent.cycle(); agent.cycle()
    assert len(cloud.received) == 1
    dev._records.append(rec("1", 17, 31))
    agent.cycle()
    assert len(cloud.received) == 2


def test_wrong_terminal_clock_is_ignored(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([Record("1", datetime(2000, 1, 1, 0, 0), 15, 0), Record("2", datetime(2026, 10, 20, 9, 0), 15, 0), rec("3", 9, 0)])
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle()
    assert [p.device_user_id for p in cloud.received] == ["3"]


def test_first_run_backfill_limit(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([rec("old", 9, 0, day=1), rec("new", 9, 0, day=11)])
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": dev}, backfill=5)
    agent.cycle()
    assert [p.device_user_id for p in cloud.received] == ["new"]


def test_one_dead_terminal_does_not_stop_the_other(tmp_path):
    two = conf(devices=[{"id": 1, "name": "A", "ip": "a", "port": 4370, "enabled": True}, {"id": 2, "name": "B", "ip": "b", "port": 4370, "enabled": True}])
    cloud = FakeCloud(two)

    class Boom:
        def __getattr__(self, n): raise TimeoutError("timed out")

    def factory(ip, port, pw, t):
        if ip == "a": raise TimeoutError("timed out")
        return FakeDevice([rec("9", 9, 0)])

    cfg = Config("https://x", "zka_k", tmp_path)
    agent = Agent(cfg, Store(tmp_path / "q.db"), cloud, factory, now=lambda: NOW)
    agent.cycle()
    by = {d["device_id"]: d for d in cloud.heartbeats[-1]["devices"]}
    assert by[1]["reachable"] is False and "timed out" in by[1]["error"]
    assert by[2]["reachable"] is True
    assert [p.device_user_id for p in cloud.received] == ["9"]


def test_test_connection_command_result_survives_a_failed_heartbeat(tmp_path):
    cloud = FakeCloud(conf(commands=[{"id": 7, "device_id": 1, "kind": "test_connection"}]))
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": FakeDevice()})
    orig = cloud.post_heartbeat
    cloud.post_heartbeat = lambda b: (_ for _ in ()).throw(CloudError("down"))
    agent.cycle()
    assert agent._cmd_results and agent._cmd_results[0]["id"] == 7
    cloud.post_heartbeat = orig
    agent.cycle()
    sent = [r for h in cloud.heartbeats for r in h["command_results"]]
    assert sent and sent[0]["ok"] and "Connected" in sent[0]["result"]


def test_import_people_command_posts_the_terminal_user_list(tmp_path):
    users = [UserInfo(1, "0042", "Maria Okafor"), UserInfo(2, "0043", "")]
    cloud = FakeCloud(conf(commands=[{"id": 3, "device_id": 1, "kind": "sync_users"}]))
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": FakeDevice(users=users)})
    agent.cycle()
    assert cloud.users_posted == [(1, [{"user_id": "0042", "name": "Maria Okafor"}, {"user_id": "0043", "name": ""}])]


def test_enrollment_keeps_existing_user_slot_and_picks_next_free_slot(tmp_path):
    existing = UserInfo(5, "0042", "Old Name", privilege=14, password="1234", card=99)
    dev = FakeDevice(users=[existing])
    cloud = FakeCloud(conf(enrollments=[{"employee_id": 10, "device_user_id": "0042", "name": "Maria Okafor"}, {"employee_id": 11, "device_user_id": "0050", "name": "New Person"}]))
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle()
    (uid1, id1, name1, base1), (uid2, id2, _, base2) = dev.written
    assert (uid1, id1, name1) == (5, "0042", "Maria Okafor") and base1 is existing   # privilege/password/card preserved
    assert (uid2, id2, base2) == (6, "0050", None)
    assert sorted(cloud.heartbeats[-1]["enrolled_employee_ids"]) == [10, 11]


def test_trim_name_respects_field_width_without_splitting_characters():
    assert trim_name("A" * 40) == "A" * 24
    assert len(trim_name("é" * 20).encode()) <= 24


def test_store_dedupes_and_survives_restart(tmp_path):
    s = Store(tmp_path / "q.db")
    p = Punch(1, "42", "2026-10-12T09:00:00+05:00")
    assert s.enqueue([p, p]) == 1 and s.enqueue([p]) == 0
    s.set("hwm:1", "x"); s.close()
    s2 = Store(tmp_path / "q.db")
    assert s2.depth() == 1 and s2.get("hwm:1") == "x"


def test_backoff_doubles_caps_and_resets():
    t = [0.0]
    b = Backoff(jitter=0, clock=lambda: t[0])
    assert [b.fail() for _ in range(10)][:4] == [2, 4, 8, 16] and b.fail() == 300
    assert not b.ready()
    b.ok()
    assert b.ready() and b.failures == 0


def test_config_validation(tmp_path):
    p = tmp_path / "agent.toml"
    with pytest.raises(ConfigError, match="not found"):
        load(p)
    p.write_text('cloud_url = "dashboard.example.com"\napi_key = "zka_x"\n')
    with pytest.raises(ConfigError, match="https"):
        load(p)
    p.write_text('cloud_url = "https://d.example.com/"\napi_key = "nope"\n')
    with pytest.raises(ConfigError, match="zka_"):
        load(p)
    p.write_text('cloud_url = "https://d.example.com/"\napi_key = "zka_abc"\n')
    c = load(p)
    assert c.cloud_url == "https://d.example.com" and c.data_dir == tmp_path / "data"


def test_same_second_punches_by_different_people_are_both_kept_across_polls(tmp_path):
    cloud = FakeCloud(conf())
    dev = FakeDevice([rec("1", 9, 0)])
    agent, _ = make(tmp_path, cloud, {"10.0.0.5": dev})
    agent.cycle()
    dev._records.append(rec("2", 9, 0))   # same second, appears after the first poll
    agent.cycle(); agent.cycle()
    assert sorted(p.device_user_id for p in cloud.received) == ["1", "2"]


def test_zk_wrapper_maps_pyzk_objects(monkeypatch):
    """Checks the wrapper against pyzk's real class shapes without needing a terminal."""
    import sys, types
    from zk.attendance import Attendance
    from zk.user import User

    class FakeConn:
        def get_attendance(self): return [Attendance("0042", datetime(2026, 10, 12, 9, 0), 15, 0, 1)]
        def get_users(self): return [User(5, "Maria\x00", 14, "pw", "1", "0042", 77)]
        def get_serialnumber(self): return "CKPG1\x00"
        def get_device_name(self): return "SpeedFace-V5L"
        def get_time(self): return datetime(2026, 10, 12, 9, 0)
        def set_user(self, **kw): self.kw = kw
        def disconnect(self): self.gone = True

    conn = FakeConn()
    seen = {}

    class FakeZK:
        def __init__(self, ip, port=4370, timeout=60, password=0, force_udp=False, ommit_ping=False): seen.update(ip=ip, port=port, ping=ommit_ping)
        def connect(self): return conn

    monkeypatch.setitem(sys.modules, "zk", types.SimpleNamespace(ZK=FakeZK))
    from zkagent.device import ZkDevice
    d = ZkDevice("10.0.0.5", 4370, 0, 5)
    assert seen == {"ip": "10.0.0.5", "port": 4370, "ping": True}
    assert d.records()[0].user_id == "0042" and d.records()[0].status == 15
    assert d.info() == {"serial": "CKPG1", "model": "SpeedFace-V5L", "enrolled_count": 1}
    u = d.users()[0]
    d.write_user(u.uid, u.user_id, "Maria Okafor", u)
    assert conn.kw == {"uid": 5, "name": "Maria Okafor", "privilege": 14, "password": "pw", "group_id": "1", "user_id": "0042", "card": 77}
    d.close()
    assert conn.gone
