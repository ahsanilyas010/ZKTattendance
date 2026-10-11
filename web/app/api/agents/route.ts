import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { sha256 } from '@/lib/agentAuth';
import { bad, currentSiteId, requireAdmin } from '@/lib/auth';

export const newKey = () => `zka_${randomBytes(24).toString('hex')}`;

/** Register an on-site agent. The key is shown once; only its hash is stored. */
export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = z.object({ name: z.string().min(1).max(80) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return bad('Give the agent a name.');
  const key = newKey();
  const { data, error } = await admin().from('agents')
    .insert({ site_id: await currentSiteId(), name: body.data.name, api_key_hash: sha256(key) }).select('id').single();
  if (error) return bad(error.message, 500);
  return NextResponse.json({ id: data.id, api_key: key });
}
