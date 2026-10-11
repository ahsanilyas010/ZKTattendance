import { NextResponse } from 'next/server';
import { sendRuleTest } from '@/lib/alerts';
import { bad, requireAdmin } from '@/lib/auth';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    await sendRuleTest(Number(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return bad((err as Error).message, 502);
  }
}
