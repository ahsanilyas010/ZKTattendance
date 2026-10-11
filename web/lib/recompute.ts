// Turns raw punches into daily_attendance rows. Run after punches arrive, after employee/shift/
// leave/holiday/settings changes, and nightly for a trailing window.
import { admin } from './supabase/admin';
import { getSettings, getSite } from './settings';
import { addDays, deriveDay, localDate, workDateOf, zonedToUtc, type Shift } from './attendance';

interface ShiftRow {
  id: number; start_time: string; end_time: string; grace_minutes: number;
  absence_cutoff_minutes: number; work_days: number; crosses_midnight: boolean; is_default: boolean;
}

export const toShift = (s: ShiftRow): Shift => ({
  startTime: s.start_time, endTime: s.end_time, graceMinutes: s.grace_minutes,
  absenceCutoffMinutes: s.absence_cutoff_minutes, workDays: s.work_days, crossesMidnight: s.crosses_midnight,
});

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Fetch every row of a query, paging past PostgREST's default 1000-row cap. */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

export interface RecomputeOpts { from: string; to: string; employeeIds?: number[]; now?: Date }

export async function recompute(siteId: number, opts: RecomputeOpts): Promise<number> {
  const db = admin();
  const now = opts.now ?? new Date();
  const [site, settings] = await Promise.all([getSite(siteId), getSettings(siteId)]);
  const tz = site.timezone;

  let q = db.from('employees').select('id,status,join_date,shift_id').eq('site_id', siteId);
  if (opts.employeeIds) q = q.in('id', opts.employeeIds);
  const { data: employees, error: e1 } = await q;
  if (e1) throw e1;
  if (!employees?.length) return 0;
  const ids = employees.map((e) => e.id);

  const { data: shiftRows, error: e2 } = await db.from('shift_schedules').select('*').eq('site_id', siteId);
  if (e2) throw e2;
  const shifts = new Map((shiftRows as ShiftRow[]).map((s) => [s.id, s]));
  const fallback = (shiftRows as ShiftRow[]).find((s) => s.is_default) ?? (shiftRows as ShiftRow[])[0];
  if (!fallback) return 0;

  // Pad the punch window so overnight shifts and timezone edges are covered.
  const lo = zonedToUtc(addDays(opts.from, -1), '00:00', tz).toISOString();
  const hi = zonedToUtc(addDays(opts.to, 2), '00:00', tz).toISOString();
  const punches = await fetchAll<{ employee_id: number; punched_at: string }>((a, b) =>
    db.from('raw_punches').select('employee_id,punched_at').in('employee_id', ids)
      .gte('punched_at', lo).lt('punched_at', hi).order('id').range(a, b));

  const [{ data: leaves }, { data: holidays }] = await Promise.all([
    db.from('leave_entries').select('employee_id,start_date,end_date').in('employee_id', ids)
      .lte('start_date', opts.to).gte('end_date', opts.from),
    db.from('holidays').select('holiday_date').eq('site_id', siteId).gte('holiday_date', opts.from).lte('holiday_date', opts.to),
  ]);
  const holidaySet = new Set((holidays ?? []).map((h) => h.holiday_date as string));

  const rows: Record<string, unknown>[] = [];
  const dates = datesBetween(opts.from, opts.to);
  for (const emp of employees) {
    const shiftRow = (emp.shift_id && shifts.get(emp.shift_id)) || fallback;
    const shift = toShift(shiftRow);
    const byDate = new Map<string, Date[]>();
    for (const p of punches) {
      if (p.employee_id !== emp.id) continue;
      const at = new Date(p.punched_at);
      const d = workDateOf(at, tz, shift);
      if (d < opts.from || d > opts.to) continue;
      (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(at);
    }
    const empLeaves = (leaves ?? []).filter((l) => l.employee_id === emp.id);
    for (const date of dates) {
      const r = deriveDay({
        date, punches: byDate.get(date) ?? [], shift, tz, now,
        dedupeWindowSec: settings.dedupe_window_sec, active: emp.status === 'active', joinDate: emp.join_date,
        onLeave: empLeaves.some((l) => l.start_date <= date && date <= l.end_date),
        isHoliday: holidaySet.has(date),
      });
      const notable = r.punchCount > 0 || r.isAbsent || r.isLeave || r.isHoliday;
      if (!notable) continue;
      rows.push({
        employee_id: emp.id, work_date: date, shift_id: shiftRow.id,
        first_in: r.firstIn?.toISOString() ?? null, last_out: r.lastOut?.toISOString() ?? null,
        worked_minutes: r.workedMinutes, punch_count: r.punchCount, is_late: r.isLate, late_minutes: r.lateMinutes,
        is_early_leave: r.isEarlyLeave, is_absent: r.isAbsent, is_leave: r.isLeave, is_holiday: r.isHoliday,
        single_punch: r.singlePunch, computed_at: now.toISOString(),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('daily_attendance').upsert(rows.slice(i, i + 500), { onConflict: 'employee_id,work_date' });
    if (error) throw error;
  }

  // Remove rows that are no longer notable (e.g. after a shift's work days changed).
  const existing = await fetchAll<{ id: number; employee_id: number; work_date: string }>((a, b) =>
    db.from('daily_attendance').select('id,employee_id,work_date').in('employee_id', ids)
      .gte('work_date', opts.from).lte('work_date', opts.to).order('id').range(a, b));
  const keep = new Set(rows.map((r) => `${r.employee_id}|${r.work_date}`));
  const stale = existing.filter((x) => !keep.has(`${x.employee_id}|${x.work_date}`)).map((x) => x.id);
  for (let i = 0; i < stale.length; i += 200) {
    const { error } = await db.from('daily_attendance').delete().in('id', stale.slice(i, i + 200));
    if (error) throw error;
  }
  return rows.length;
}

/** Attach previously-unknown punches to an employee once their device ID is bound. */
export async function bindUnknownPunches(siteId: number, employeeId: number, deviceUserId: string): Promise<number> {
  const { data, error } = await admin().from('raw_punches').update({ employee_id: employeeId })
    .eq('site_id', siteId).eq('device_user_id', deviceUserId).is('employee_id', null).select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

export const todayFor = (tz: string, now = new Date()) => localDate(now, tz);
