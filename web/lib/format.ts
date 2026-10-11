import { localParts } from './attendance';

const p2 = (n: number) => String(n).padStart(2, '0');
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtTime = (iso: string | null, tz: string) => {
  if (!iso) return '–';
  const p = localParts(new Date(iso), tz);
  return `${p2(p.h)}:${p2(p.min)}`;
};
export const fmtTimeSec = (iso: string, tz: string) => {
  const p = localParts(new Date(iso), tz);
  return `${p2(p.h)}:${p2(p.min)}:${p2(p.s)}`;
};
export const fmtDay = (iso: string, tz: string) => {
  const p = localParts(new Date(iso), tz);
  return `${DN[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MN[p.m - 1]}`;
};
export const fmtDate = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${DN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MN[m - 1]}`;
};
export const ago = (iso: string | null, now = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const hoursLabel = (min: number | null) => (min == null ? '–' : `${Math.floor(min / 60)}h ${p2(min % 60)}m`);
