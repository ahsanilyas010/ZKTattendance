import { cookies } from 'next/headers';
import { ACCESS_COOKIE, configuredKey, verifyToken } from './access';

/** True when the request carries a valid access-key session cookie (server components and route handlers). */
export async function hasAccessSession(): Promise<boolean> {
  const key = configuredKey();
  if (!key) return false;
  return verifyToken((await cookies()).get(ACCESS_COOKIE)?.value, key);
}
