# ZKTeco attendance

A replacement for ZKTime 5.0: employee directory with names (not just ID numbers), a live punch feed,
de-duplicated daily attendance with Excel export, email alerts, and device/sync health, managed from
any browser.

```
 ┌───────────────────────── on site ─────────────────────────┐        ┌──────────── cloud ────────────┐
 │  ZKTeco terminal ──LAN :4370──▶ zkagent (on-site PC)      │ HTTPS  │  Vercel: Next.js dashboard+API │
 │  (face / finger / card)         • polls, queues in SQLite ├───────▶│  Supabase: Postgres + Auth     │
 │                                 • retries with backoff    │        │  pg_cron ──▶ /api/jobs/tick    │
 └───────────────────────────────────────────────────────────┘        └───────────────────────────────┘
```

* **agent/** Python service for the on-site PC (Windows or Linux). Talks the raw ZKTeco protocol with
  [pyzk](https://github.com/fananimi/pyzk), so no vendor SDK is needed. Punches are written to a local
  SQLite queue first, so an internet outage loses nothing.
* **web/** Next.js dashboard and API, deployed on Vercel.
* **supabase/** Postgres schema in its own `attendance` schema (so it can share a project with other apps), row-level security, demo seed.
* **docs/** [DEPLOY](docs/DEPLOY.md) · [AGENT-SETUP](docs/AGENT-SETUP.md) · [RUNBOOK](docs/RUNBOOK.md)

## How the problems from ZKTime are handled

| Problem | Solution |
|---|---|
| Only ID numbers visible | Employee directory is the source of truth; every screen shows names. Unknown IDs are flagged and can be assigned to a person in one click, which also fixes their earlier punches. |
| No in/out flag, duplicate scans | Raw punches are stored untouched. Reports collapse scans within a configurable window (default 2 min); first scan of the day is the first-in, last is the last-out. |
| No Excel | Reports page and `/api/export`: daily summary and/or raw punch log, by date range, employee or department, one-off or scheduled by email. |
| No email alerts | Alert rules (late, absent, device offline, agent offline, daily summary) editable in the dashboard. One email per rule, subject and day. |
| Internet drops | Agent keeps polling the terminal and queues locally; uploads resume with exponential backoff and are idempotent. |

## Local development

```bash
cd web && npm install && cp ../.env.example .env.local   # fill in Supabase values
npm run dev          # dashboard on http://localhost:3000
npm test             # attendance logic tests
cd ../agent && python -m venv .venv && .venv/bin/pip install -e ".[test]" && .venv/bin/pytest
```

Go-live steps are in [docs/DEPLOY.md](docs/DEPLOY.md).
