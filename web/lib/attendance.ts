// Pure attendance logic: duplicate-punch collapsing and per-day derivation.
// No I/O here so it can be unit-tested and reused by the API, exports and alerts.

export interface Shift {
  startTime: string; // 'HH:MM' or 'HH:MM:SS'
  endTime: string;
  graceMinutes: number;
  absenceCutoffMinutes: number;
  workDays: number; // bitmask Sun=1 Mon=2 Tue=4 Wed=8 Thu=16 Fri=32 Sat=64
  crossesMidnight: boolean;
}

export interface DayResult {
  workDate: string; // YYYY-MM-DD in site timezone
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number | null;
  punchCount: number; // after de-duplication
  isLate: boolean;
  lateMinutes: number;
  isEarlyLeave: boolean;
  isAbsent: boolean;
  isLeave: boolean;
  isHoliday: boolean;
  singlePunch: boolean;
}

const MIN = 60_000;

/** Collapse punches that fall within `windowSec` of the previously kept punch. Input need not be sorted. */
export function dedupePunches(times: Date[], windowSec: number): Date[] {
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const kept: Date[] = [];
  for (const t of sorted) {
    const prev = kept[kept.length - 1];
    if (!prev || t.getTime() - prev.getTime() > windowSec * 1000) kept.push(t);
  }
  return kept;
}

interface Parts { y: number; m: number; d: number; h: number; min: number; s: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(at: Date, tz: string): Parts {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(at)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, min: o.minute, s: o.second };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(at: Date, tz: string): string {
  return ymd(localParts(at, tz));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of week 0=Sunday for a YYYY-MM-DD calendar date. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant at which the wall clock in `tz` reads `date` `time`. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  let guess = wall - offsetMs(new Date(wall), tz);
  guess = wall - offsetMs(new Date(guess), tz); // second pass settles DST edges
  return new Date(guess);
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Which shift date a punch belongs to. For overnight shifts, punches in the small hours
 * (before shift end + 4h) belong to the previous calendar day.
 */
export function workDateOf(at: Date, tz: string, shift: Pick<Shift, 'endTime' | 'crossesMidnight' | 'startTime'>): string {
  const p = localParts(at, tz);
  const date = ymd(p);
  if (!shift.crossesMidnight) return date;
  const minutes = p.h * 60 + p.min;
  const lateBound = toMin(shift.endTime) + 240;
  return minutes < lateBound && minutes < toMin(shift.startTime) ? addDays(date, -1) : date;
}

export interface DeriveInput {
  date: string;
  punches: Date[]; // raw punches for this employee that belong to `date`
  shift: Shift;
  tz: string;
  dedupeWindowSec: number;
  now: Date;
  active: boolean;
  joinDate: string | null;
  onLeave: boolean;
  isHoliday: boolean;
}

export function deriveDay(i: DeriveInput): DayResult {
  const kept = dedupePunches(i.punches, i.dedupeWindowSec);
  const startUtc = zonedToUtc(i.date, i.shift.startTime, i.tz);
  const endDate = i.shift.crossesMidnight ? addDays(i.date, 1) : i.date;
  const endUtc = zonedToUtc(endDate, i.shift.endTime, i.tz);

  const isWorkDay = (i.shift.workDays & (1 << dayOfWeek(i.date))) !== 0;
  const joined = !i.joinDate || i.joinDate <= i.date;
  const expected = isWorkDay && i.active && joined && !i.onLeave && !i.isHoliday;

  const base: DayResult = {
    workDate: i.date, firstIn: null, lastOut: null, workedMinutes: null, punchCount: kept.length,
    isLate: false, lateMinutes: 0, isEarlyLeave: false, isAbsent: false,
    isLeave: i.onLeave, isHoliday: i.isHoliday, singlePunch: false,
  };

  if (kept.length === 0) {
    // Absence is only decided once the cutoff after shift start has passed.
    const decided = i.now.getTime() >= startUtc.getTime() + i.shift.absenceCutoffMinutes * MIN;
    return { ...base, isAbsent: expected && decided };
  }

  const firstIn = kept[0];
  const single = kept.length === 1;
  const lastOut = single ? null : kept[kept.length - 1];
  const lateMs = firstIn.getTime() - startUtc.getTime();
  const isLate = lateMs > i.shift.graceMinutes * MIN;
  // Early leave is only judged once the shift is over and there is a real clock-out.
  const shiftOver = i.now.getTime() >= endUtc.getTime();
  const isEarlyLeave = !!lastOut && shiftOver && lastOut.getTime() < endUtc.getTime() - i.shift.graceMinutes * MIN;

  return {
    ...base,
    firstIn,
    lastOut,
    workedMinutes: lastOut ? Math.floor((lastOut.getTime() - firstIn.getTime()) / MIN) : null,
    isLate: isLate && expected,
    lateMinutes: isLate && expected ? Math.floor(lateMs / MIN) : 0,
    isEarlyLeave: isEarlyLeave && expected,
    singlePunch: single,
  };
}

export function formatHours(minutes: number | null): string {
  if (minutes == null) return '';
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}
