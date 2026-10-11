-- Optional demo data so the dashboard can be reviewed before the terminal is connected.
-- Run in the Supabase SQL editor. Safe to skip in production. Does nothing if employees already exist.
-- After running, trigger a recompute (Settings > Save, or call /api/jobs/tick) to build the daily summaries.
do $$
declare
  s bigint; sh bigint; d bigint; e bigint; day date; n int := 0; r int; person record; arrive numeric;
begin
  if exists (select 1 from public.employees) then raise notice 'employees exist; skipping demo seed'; return; end if;
  select id into s from public.sites order by id limit 1;
  select id into sh from public.shift_schedules where site_id = s and is_default;
  insert into public.devices (site_id, name, ip, port, location, model, serial, status, last_seen_at)
    values (s, 'Front entrance', '192.168.1.201', 4370, 'Main entrance, ground floor', 'ZKTeco SpeedFace-V5L', 'DEMO0001', 'unknown', null)
    returning id into d;
  for person in select * from (values
    ('0001','Maria Okafor','Office'),('0002','Daniel Reyes','Kitchen'),('0003','Priya Nair','Office'),
    ('0004','Tomas Lindqvist','Warehouse'),('0005','Aisha Bello','Front of house'),('0006','Kenji Watanabe','Warehouse'),
    ('0007','Sofia Marchetti','Kitchen'),('0008','Liam O''Connor','Warehouse'),('0009','Hana Kim','Front of house'),
    ('0010','Mateo Silva','Kitchen')) as t(uid, nm, dept)
  loop
    insert into public.employees (site_id, name, device_user_id, department, shift_id, join_date)
      values (s, person.nm, person.uid, person.dept, sh, current_date - 120) returning id into e;
    for r in 0..9 loop
      day := (now() at time zone 'Asia/Karachi')::date - r;
      continue when extract(dow from day) = 0;                                 -- Sundays off
      continue when abs(hashtext(person.uid || day::text)) % 12 = 0;           -- the odd absence
      -- arrival between 08:40 and 09:35 local; every third person is sometimes late
      arrive := 520 + (abs(hashtext('a' || person.uid || day::text)) % 56);
      insert into public.raw_punches (site_id, device_id, employee_id, device_user_id, punched_at, verify_method, dedupe_key)
      values
        (s, d, e, person.uid, ((day + time '00:00') + make_interval(mins => arrive::int)) at time zone 'Asia/Karachi', 'Face', 'demo|' || person.uid || '|' || day || '|in'),
        -- a duplicate scan 40 seconds later, to show duplicate handling
        (s, d, e, person.uid, ((day + time '00:00') + make_interval(mins => arrive::int, secs => 40)) at time zone 'Asia/Karachi', 'Face', 'demo|' || person.uid || '|' || day || '|dup'),
        (s, d, e, person.uid, ((day + time '17:30') + make_interval(mins => abs(hashtext('o' || person.uid || day::text)) % 25)) at time zone 'Asia/Karachi', 'Face', 'demo|' || person.uid || '|' || day || '|out');
      n := n + 3;
    end loop;
  end loop;
  raise notice 'demo data inserted: % punches', n;
end $$;
