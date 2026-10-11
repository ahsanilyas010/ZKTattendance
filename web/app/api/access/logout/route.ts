import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, MODE_COOKIE } from '@/lib/access';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(MODE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
