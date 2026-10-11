import { describe, it, expect } from 'vitest';
import { dedupePunches, deriveDay, workDateOf, zonedToUtc, localDate, addDays, dayOfWeek, type Shift } from '../lib/attendance';

const TZ = 'Asia/Karachi'; // UTC+5, no DST
const day: Shift = { startTime: '09:00', endTime: '17:30', graceMinutes: 10, absenceCutoffMinutes: 30, workDays: 126, crossesMidnight: false };
const at = (date: string, t: string) => zonedToUtc(date, t, TZ);
const base = { tz: TZ, dedupeWindowSec: 120, active: true, joinDate: null, onLeave: false, isHoliday: false };

describe('dedupePunches', () => {
  it('collapses duplicates inside the window and keeps the first', () => {
    const t = ['2026-10-05T04:00:00Z', '2026-10-05T04:00:40Z', '2026-10-05T04:01:50Z', '2026-10-05T04:05:00Z'].map((s) => new Date(s));
    expect(dedupePunches(t, 120).map((d) => d.toISOString())).toEqual(['2026-10-05T04:00:00.000Z', '2026-10-05T04:05:00.000Z']);
  });
  it('sorts unsorted input', () => {
    const t = [new Date('2026-10-05T05:00:00Z'), new Date('2026-10-05T04:00:00Z')];
    expect(dedupePunches(t, 120)[0].toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });
  it('measures the window from the last kept punch, not the last seen', () => {
    const t = [0, 100, 200].map((s) => new Date(Date.UTC(2026, 9, 5, 4, 0, s)));
    expect(dedupePunches(t, 120)).toHaveLength(2); // 0 kept, 100 dropped, 200 kept (200s from 0)
  });
});

describe('timezone helpers', () => {
  it('converts local wall time to UTC', () => {
    expect(at('2026-10-05', '09:00').toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });
  it('local date rolls over at local midnight', () => {
    expect(localDate(new Date('2026-10-05T19:30:00Z'), TZ)).toBe('2026-10-06');
  });
  it('handles DST zones', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '09:00', 'Europe/London').toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });
  it('date arithmetic', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(dayOfWeek('2026-10-11')).toBe(0);
  });
});

describe('deriveDay', () => {
  const now = at('2026-10-09', '23:00'); // after the day is over
  const d = '2026-10-09'; // Friday

  it('on-time with in and out', () => {
    const r = deriveDay({ ...base, date: d, shift: day, now, punches: [at(d, '08:55'), at(d, '17:35')] });
    expect(r.isLate).toBe(false);
    expect(r.workedMinutes).toBe(8 * 60 + 40);
    expect(r.isEarlyLeave).toBe(false);
    expect(r.isAbsent).toBe(false);
  });
  it('duplicate scans collapse so a day with only repeated scans is a single punch', () => {
    const r = deriveDay({ ...base, date: d, shift: day, now, punches: [at(d, '08:55:00'), at(d, '08:55:30')] });
    expect(r.punchCount).toBe(1);
    expect(r.singlePunch).toBe(true);
    expect(r.lastOut).toBeNull();
    expect(r.workedMinutes).toBeNull();
  });
  it('grace boundary: exactly at grace is not late, one minute over is', () => {
    expect(deriveDay({ ...base, date: d, shift: day, now, punches: [at(d, '09:10')] }).isLate).toBe(false);
    const r = deriveDay({ ...base, date: d, shift: day, now, punches: [at(d, '09:11')] });
    expect(r.isLate).toBe(true);
    expect(r.lateMinutes).toBe(11);
  });
  it('early leave only after shift end and beyond grace', () => {
    const early = deriveDay({ ...base, date: d, shift: day, now, punches: [at(d, '09:00'), at(d, '16:00')] });
    expect(early.isEarlyLeave).toBe(true);
    const sameDayStillOpen = deriveDay({ ...base, date: d, shift: day, now: at(d, '15:00'), punches: [at(d, '09:00'), at(d, '14:00')] });
    expect(sameDayStillOpen.isEarlyLeave).toBe(false);
  });
  it('absent only after the cutoff, only on work days', () => {
    expect(deriveDay({ ...base, date: d, shift: day, now: at(d, '09:20'), punches: [] }).isAbsent).toBe(false);
    expect(deriveDay({ ...base, date: d, shift: day, now: at(d, '09:31'), punches: [] }).isAbsent).toBe(true);
    const sunday = '2026-10-11';
    expect(deriveDay({ ...base, date: sunday, shift: day, now: at(sunday, '23:00'), punches: [] }).isAbsent).toBe(false);
  });
  it('leave, holiday, inactive and not-yet-joined are never absent', () => {
    const args = { ...base, date: d, shift: day, now, punches: [] as Date[] };
    expect(deriveDay({ ...args, onLeave: true }).isAbsent).toBe(false);
    expect(deriveDay({ ...args, onLeave: true }).isLeave).toBe(true);
    expect(deriveDay({ ...args, isHoliday: true }).isAbsent).toBe(false);
    expect(deriveDay({ ...args, active: false }).isAbsent).toBe(false);
    expect(deriveDay({ ...args, joinDate: '2026-10-10' }).isAbsent).toBe(false);
  });
  it('a late punch on a holiday is not flagged late', () => {
    expect(deriveDay({ ...base, date: d, shift: day, now, isHoliday: true, punches: [at(d, '11:00')] }).isLate).toBe(false);
  });
});

describe('overnight shifts', () => {
  const night: Shift = { startTime: '22:00', endTime: '06:00', graceMinutes: 10, absenceCutoffMinutes: 30, workDays: 127, crossesMidnight: true };
  it('attaches small-hours punches to the previous date', () => {
    expect(workDateOf(at('2026-10-06', '05:50'), TZ, night)).toBe('2026-10-05');
    expect(workDateOf(at('2026-10-05', '21:55'), TZ, night)).toBe('2026-10-05');
  });
  it('computes hours across midnight', () => {
    const r = deriveDay({ ...base, date: '2026-10-05', shift: night, now: at('2026-10-06', '12:00'), punches: [at('2026-10-05', '21:58'), at('2026-10-06', '06:05')] });
    expect(r.workedMinutes).toBe(8 * 60 + 7);
    expect(r.isLate).toBe(false);
    expect(r.isEarlyLeave).toBe(false);
  });
});
