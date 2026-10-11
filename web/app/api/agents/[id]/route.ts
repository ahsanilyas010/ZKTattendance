import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { bad, requireAdmin } from '@/lib/auth';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = z.object({ poll_interval_sec: z.number().int().min(5).max(3600) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return bad('Polling interval must be between 5 and 3600 seconds.');
  const { error } = await admin().from('agents').update(body.data).eq('id', Number(id));
  if (error) return bad(error.message, 500);
  return NextResponse.json({ ok: true });
}
