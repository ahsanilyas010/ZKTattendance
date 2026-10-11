import { NextResponse } from 'next/server';
import { supabaseServer } from './supabase/server';
import { admin } from './supabase/admin';

/** Defence in depth: the proxy already blocks signed-out calls, but every admin route re-checks. */
export async function requireAdmin(): Promise<NextResponse | null> {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  if (data?.claims?.app_metadata?.role !== 'admin') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

let cachedSite: number | null = null;
/** The site this dashboard manages. One site today; multi-site would resolve it from the session. */
export async function currentSiteId(): Promise<number> {
  if (cachedSite) return cachedSite;
  const { data, error } = await admin().from('sites').select('id').order('id').limit(1).single();
  if (error || !data) throw new Error('No site configured. Run the Supabase migrations.');
  return (cachedSite = data.id);
}

export const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
