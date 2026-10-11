import { NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/admin';
import { sha256 } from '@/lib/agentAuth';
import { bad, requireAdmin } from '@/lib/auth';
import { newKey } from '../../route';

/** Issue a new key; the old one stops working immediately. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await ctx.params;
  const key = newKey();
  const { data, error } = await admin().from('agents').update({ api_key_hash: sha256(key) }).eq('id', Number(id)).select('id');
  if (error) return bad(error.message, 500);
  if (!data?.length) return bad('Agent not found', 404);
  return NextResponse.json({ api_key: key });
}
