import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { admin } from './supabase/admin';

export interface AgentRow {
  id: number; site_id: number; name: string; poll_interval_sec: number;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Resolve the calling agent from its X-Agent-Key header, or return a 401 response. */
export async function authAgent(req: Request): Promise<AgentRow | NextResponse> {
  const key = req.headers.get('x-agent-key');
  if (!key) return NextResponse.json({ error: 'missing agent key' }, { status: 401 });
  const { data } = await admin().from('agents').select('id,site_id,name,poll_interval_sec')
    .eq('api_key_hash', sha256(key)).maybeSingle();
  if (!data) return NextResponse.json({ error: 'invalid agent key' }, { status: 401 });
  return data as AgentRow;
}

export const isResponse = (x: unknown): x is NextResponse => x instanceof NextResponse;
