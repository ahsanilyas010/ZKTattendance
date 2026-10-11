import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ACCESS_COOKIE, MODE_COOKIE, SESSION_DAYS, clearFailures, configuredKey, keysMatch, makeToken, recordFailure, tooManyFailures } from '@/lib/access';

const Body = z.object({ key: z.string().min(1).max(500) });

export async function POST(req: Request) {
  const key = configuredKey();
  if (!key) {
    return NextResponse.json({ error: 'Access key sign-in is not set up. Add ACCESS_KEY (16+ characters) in Vercel and redeploy, or sign in with email.' }, { status: 503 });
  }
  const id = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (tooManyFailures(id)) return NextResponse.json({ error: 'Too many attempts. Wait ten minutes and try again.' }, { status: 429 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success || !keysMatch(body.data.key.trim(), key)) {
    recordFailure(id);
    await new Promise((r) => setTimeout(r, 600)); // slows down guessing
    return NextResponse.json({ error: 'That access key is not right.' }, { status: 401 });
  }
  clearFailures(id);
  const res = NextResponse.json({ ok: true });
  const maxAge = SESSION_DAYS * 86400;
  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set(ACCESS_COOKIE, makeToken(key), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge });
  res.cookies.set(MODE_COOKIE, 'key', { httpOnly: false, sameSite: 'lax', secure, path: '/', maxAge });
  return res;
}
