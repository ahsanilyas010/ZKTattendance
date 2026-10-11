-- ZKTeco attendance: core schema.
-- Access model: the dashboard signs in with Supabase Auth (signups disabled, one admin user whose
-- app_metadata.role = 'admin'). RLS lets only that role touch data. Agent and cron endpoints run
-- server-side with the service-role key, which bypasses RLS.

create extension if not exists pgcrypto;

create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path = ''
as $$ select coalesce((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false) $$;

-- ---------------------------------------------------------------- sites / agents / devices
create table public.sites (
  id bigint generated always as identity primary key,
  name text not null,
  timezone text not null default 'Asia/Karachi',
  created_at timestamptz not null default now()
);

create table public.agents (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  api_key_hash text not null unique,          -- sha256 hex of the key; plaintext is shown once
  poll_interval_sec int not null default 30 check (poll_interval_sec between 5 and 3600),
  last_seen_at timestamptz,
  version text,
  hostname text,
  queue_depth int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index agents_site_idx on public.agents(site_id);

create table public.devices (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  ip inet not null,
  port int not null default 4370 check (port between 1 and 65535),
  comm_password int not null default 0,
  location text,
  model text,
  serial text,
  enabled boolean not null default true,
  status text not null default 'unknown' check (status in ('online','offline','unknown')),
  consecutive_failures int not null default 0,
  last_seen_at timestamptz,
  last_punch_at timestamptz,
  enrolled_count int,
  clock_drift_sec int,
  last_error text,
  created_at timestamptz not null default now(),
  unique (site_id, ip, port)
);
create index devices_site_idx on public.devices(site_id);

-- Commands the dashboard queues for the agent (e.g. "test connection").
create table public.device_commands (
  id bigint generated always as identity primary key,
  device_id bigint not null references public.devices(id) on delete cascade,
  kind text not null check (kind in ('test_connection','sync_users')),
  status text not null default 'pending' check (status in ('pending','done','failed')),
  result text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index device_commands_pending_idx on public.device_commands(device_id) where status = 'pending';

-- ---------------------------------------------------------------- shifts / employees
create table public.shift_schedules (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  grace_minutes int not null default 10 check (grace_minutes >= 0),
  absence_cutoff_minutes int not null default 30 check (absence_cutoff_minutes >= 0),
  work_days smallint not null default 126,    -- bitmask, Sun=1 Mon=2 Tue=4 Wed=8 Thu=16 Fri=32 Sat=64 (126 = Mon-Sat)
  crosses_midnight boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index shift_one_default_per_site on public.shift_schedules(site_id) where is_default;

create table public.employees (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  device_user_id text,                         -- ID number on the terminal; null = not enrolled yet
  department text not null default 'General',
  photo_path text,
  status text not null default 'active' check (status in ('active','inactive')),
  join_date date,
  shift_id bigint references public.shift_schedules(id) on delete set null,
  notes text,
  enrollment_pending boolean not null default false,  -- agent should push name/ID to the device
  created_at timestamptz not null default now(),
  constraint employees_device_user_id_nonempty check (device_user_id is null or length(trim(device_user_id)) > 0)
);
create unique index employees_site_device_user_uk on public.employees(site_id, device_user_id) where device_user_id is not null;
create index employees_shift_idx on public.employees(shift_id);
create index employees_dept_idx on public.employees(site_id, department);

-- ---------------------------------------------------------------- punches / derived attendance
create table public.raw_punches (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  device_id bigint not null references public.devices(id) on delete cascade,
  employee_id bigint references public.employees(id) on delete set null,
  device_user_id text not null,
  punched_at timestamptz not null,
  verify_method text,
  punch_type_raw int,
  dedupe_key text not null unique,             -- sha256(serial|user_id|timestamp); idempotent re-delivery
  received_at timestamptz not null default now()
);
create index raw_punches_emp_time_idx on public.raw_punches(employee_id, punched_at);
create index raw_punches_dev_time_idx on public.raw_punches(device_id, punched_at desc);
create index raw_punches_time_idx on public.raw_punches(punched_at desc);
create index raw_punches_unknown_idx on public.raw_punches(site_id, device_user_id) where employee_id is null;

create table public.daily_attendance (
  id bigint generated always as identity primary key,
  employee_id bigint not null references public.employees(id) on delete cascade,
  work_date date not null,
  shift_id bigint references public.shift_schedules(id) on delete set null,
  first_in timestamptz,
  last_out timestamptz,
  worked_minutes int,
  punch_count int not null default 0,
  is_late boolean not null default false,
  late_minutes int not null default 0,
  is_early_leave boolean not null default false,
  is_absent boolean not null default false,
  is_leave boolean not null default false,
  is_holiday boolean not null default false,
  single_punch boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index daily_attendance_date_idx on public.daily_attendance(work_date);

create table public.leave_entries (
  id bigint generated always as identity primary key,
  employee_id bigint not null references public.employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  note text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index leave_entries_emp_idx on public.leave_entries(employee_id, start_date, end_date);

create table public.holidays (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  holiday_date date not null,
  name text not null,
  unique (site_id, holiday_date)
);

-- ---------------------------------------------------------------- alerts
create table public.alert_rules (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  trigger_type text not null check (trigger_type in ('late','absent','device_offline','agent_offline','daily_summary')),
  threshold_minutes int not null default 15 check (threshold_minutes >= 0),
  send_at time,                                -- daily_summary only
  department text,                             -- null = all
  employee_id bigint references public.employees(id) on delete cascade,  -- null = everyone in scope
  channel text not null default 'email' check (channel in ('email')),
  recipients text[] not null default '{}',
  subject_template text not null default '',
  body_template text not null default '',
  enabled boolean not null default true,
  last_sent_at timestamptz,
  last_sent_summary text,
  created_at timestamptz not null default now()
);

-- One row per (rule, subject, day) that has been notified; the unique index is the dedupe guarantee.
create table public.alert_events (
  id bigint generated always as identity primary key,
  rule_id bigint not null references public.alert_rules(id) on delete cascade,
  subject_key text not null,                   -- e.g. 'emp:12', 'dev:3', 'agent:1', 'summary'
  event_date date not null,
  status text not null default 'sent' check (status in ('sent','failed')),
  error text,
  sent_at timestamptz not null default now(),
  unique (rule_id, subject_key, event_date)
);

-- ---------------------------------------------------------------- exports
create table public.export_templates (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  kind text not null default 'both' check (kind in ('raw','daily','both')),
  date_range text not null default 'last_week'
    check (date_range in ('today','yesterday','last7','last_week','last_month','this_month')),
  department text,
  employee_id bigint references public.employees(id) on delete cascade,
  late_absent_only boolean not null default false,
  frequency text not null default 'weekly' check (frequency in ('daily','weekly','monthly')),
  weekday smallint check (weekday between 0 and 6),   -- 0=Sunday
  day_of_month smallint check (day_of_month between 1 and 28),
  run_at time not null default '07:00',
  recipients text[] not null default '{}',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_status text,
  created_at timestamptz not null default now()
);

create table public.export_jobs (
  id bigint generated always as identity primary key,
  template_id bigint references public.export_templates(id) on delete set null,
  params jsonb not null default '{}',
  status text not null default 'done' check (status in ('done','failed')),
  rows_daily int,
  rows_raw int,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- settings
create table public.settings (
  site_id bigint not null references public.sites(id) on delete cascade,
  key text not null,
  value jsonb not null,
  primary key (site_id, key)
);

-- ---------------------------------------------------------------- RLS: admin only
do $$
declare t text;
begin
  foreach t in array array['sites','agents','devices','device_commands','shift_schedules','employees',
    'raw_punches','daily_attendance','leave_entries','holidays','alert_rules','alert_events',
    'export_templates','export_jobs','settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t || '_admin_all', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Secrets must never reach the browser: settings (SMTP password) and agent key hashes are read
-- server-side with the service role only.
drop policy settings_admin_all on public.settings;
drop policy agents_admin_all on public.agents;
revoke all on public.settings from authenticated;
revoke all on public.agents from authenticated;
-- Dashboard still needs agent health (without the key hash), so expose it through a definer function.
create or replace function public.list_agents() returns table (
  id bigint, site_id bigint, name text, poll_interval_sec int, last_seen_at timestamptz,
  version text, hostname text, queue_depth int, last_error text)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.site_id, a.name, a.poll_interval_sec, a.last_seen_at, a.version, a.hostname, a.queue_depth, a.last_error
  from public.agents a
  where (select public.is_admin())
$$;
revoke execute on function public.list_agents() from public, anon;
grant execute on function public.list_agents() to authenticated;

-- ---------------------------------------------------------------- storage: employee photos (private)
insert into storage.buckets (id, name, public) values ('employee-photos', 'employee-photos', false)
on conflict (id) do nothing;
create policy employee_photos_admin on storage.objects for all to authenticated
  using (bucket_id = 'employee-photos' and (select public.is_admin()))
  with check (bucket_id = 'employee-photos' and (select public.is_admin()));

-- ---------------------------------------------------------------- seed: first site + default shift
insert into public.sites (name) values ('Main site');
insert into public.shift_schedules (site_id, name, start_time, end_time, grace_minutes, work_days, is_default)
  values (1, 'Day', '09:00', '17:30', 10, 126, true);
