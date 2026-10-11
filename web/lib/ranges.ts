// Pure helpers shared by server and client code (no Node-only imports).
import { addDays, dayOfWeek, localDate, zonedToUtc } from './attendance';

export type DateRangeKey = 'today' | 'yesterday' | 'last7' | 'last_week' | 'last_month' | 'this_month';

export const RANGE_LABELS: Record<DateRangeKey, string> = {
  today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 days', last_week: 'Last week (Mon–Sun)', this_month: 'This month so far', last_month: 'Last month',
};

export function resolveRange(key: DateRangeKey, tz: string, now = new Date()): { from: string; to: string } {
  const today = localDate(now, tz);
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last_week': {
      const back = (dayOfWeek(today) + 6) % 7; // days since Monday
      const monday = addDays(today, -back - 7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'this_month': return { from: `${y}-${pad(m)}-01`, to: today };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${pad(pm)}-01`, to: addDays(`${y}-${pad(m)}-01`, -1) };
    }
  }
}

export const parseRecipients = (s: string): string[] =>
  s.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));

export interface ScheduleLike {
  frequency: 'daily' | 'weekly' | 'monthly'; weekday: number | null; day_of_month: number | null; run_at: string;
}

/** The next instant a schedule will fire, or null if none within ~2 months. */
export function nextRun(t: ScheduleLike, tz: string, now = new Date()): Date | null {
  const today = localDate(now, tz);
  for (let i = 0; i < 62; i++) {
    const date = addDays(today, i);
    const ok = t.frequency === 'daily' ||
      (t.frequency === 'weekly' && dayOfWeek(date) === (t.weekday ?? 1)) ||
      (t.frequency === 'monthly' && Number(date.slice(8)) === (t.day_of_month ?? 1));
    if (!ok) continue;
    const at = zonedToUtc(date, t.run_at.slice(0, 5), tz);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** Sensible "covers" default for each frequency. */
export const defaultRange = (f: ScheduleLike['frequency']): DateRangeKey => (f === 'daily' ? 'yesterday' : f === 'weekly' ? 'last_week' : 'last_month');
