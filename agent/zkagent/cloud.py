from __future__ import annotations

import requests

from . import __version__
from .store import Punch


class CloudError(Exception):
    """The cloud could not be reached or rejected the request."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Cloud:
    def __init__(self, base_url: str, api_key: str, timeout: float = 20, session: requests.Session | None = None):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.s = session or requests.Session()
        self.s.headers.update({"X-Agent-Key": api_key, "User-Agent": f"zkagent/{__version__}"})

    def _call(self, method: str, path: str, **kw):
        try:
            r = self.s.request(method, self.base + path, timeout=self.timeout, **kw)
        except requests.RequestException as e:  # DNS failure, timeout, connection refused, TLS...
            raise CloudError(f"cannot reach {self.base}: {e.__class__.__name__}") from e
        if r.status_code == 401:
            raise CloudError("the cloud rejected the agent key (401). Create a new key in the dashboard.", 401)
        if r.status_code >= 400:
            detail = ""
            try:
                detail = r.json().get("error", "")
            except ValueError:
                pass
            raise CloudError(f"HTTP {r.status_code} {detail}".strip(), r.status_code)
        try:
            return r.json()
        except ValueError as e:
            raise CloudError("the cloud returned something that is not JSON") from e

    def get_config(self) -> dict:
        return self._call("GET", "/api/agent/config")

    def post_punches(self, punches: list[Punch]) -> int:
        body = {"punches": [
            {"device_id": p.device_id, "device_user_id": p.device_user_id, "punched_at": p.punched_at,
             "verify_method": p.verify_method, "punch_type": p.punch_type} for p in punches]}
        return len(self._call("POST", "/api/agent/punches", json=body).get("accepted", []))

    def post_heartbeat(self, body: dict) -> None:
        self._call("POST", "/api/agent/heartbeat", json=body)

    def post_users(self, device_id: int, users: list[dict]) -> dict:
        return self._call("POST", "/api/agent/users", json={"device_id": device_id, "users": users})
