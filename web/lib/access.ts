// Shared access key: a simpler alternative to email + password. The key lives only in the ACCESS_KEY
// environment variable on the server. After one correct entry the browser gets a signed, HttpOnly cookie
// (90 days). Changing ACCESS_KEY signs everyone out. Email sign-in keeps working alongside it.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ACCESS_COOKIE = 'zk_access';
/** Readable by the page (not secret) so the browser knows to route data calls through the server. */
export const MODE_COOKIE = 'zk_mode';
export const SESSION_DAYS = 90;
export const MIN_KEY_LENGTH = 16;

/** The configured key, or null when unset or too short to be safe. */
export function configuredKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.ACCESS_KEY?.trim();
  return k && k.length >= MIN_KEY_LENGTH ? k : null;
}

const sign = (key: string, exp: number) => createHmac('sha256', key).update(`zk-access:${exp}`).digest('hex');

export function makeToken(key: string, now = Date.now(), days = SESSION_DAYS): string {
  const exp = Math.floor(now / 1000) + days * 86400;
  return `${exp}.${sign(key, exp)}`;
}

export function verifyToken(token: string | undefined | null, key: string | null, now = Date.now()): boolean {
  if (!token || !key) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isInteger(exp) || exp * 1000 < now) return false;
  const want = Buffer.from(sign(key, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function keysMatch(given: string, key: string): boolean {
  // Hash both sides so lengths always match and comparison time does not depend on the content.
  const h = (s: string) => createHmac('sha256', 'zk-compare').update(s).digest();
  return timingSafeEqual(h(given), h(key));
}

/** Best-effort throttle: 8 wrong keys per 10 minutes per client. Per server instance, so a speed bump, not a lock. */
const failures = new Map<string, { n: number; since: number }>();
export function tooManyFailures(id: string, now = Date.now()): boolean {
  const f = failures.get(id);
  return !!f && now - f.since < 600_000 && f.n >= 8;
}
export function recordFailure(id: string, now = Date.now()) {
  const f = failures.get(id);
  if (!f || now - f.since >= 600_000) failures.set(id, { n: 1, since: now });
  else f.n++;
  if (failures.size > 5000) failures.clear();
}
export function clearFailures(id: string) {
  failures.delete(id);
}
