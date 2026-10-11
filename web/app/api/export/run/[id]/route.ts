import { NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/admin';
import { runExportTemplate } from '@/lib/scheduledExports';
import { bad, requireAdmin } from '@/lib/auth';

/** "Send now" for a scheduled export. Does not change its schedule. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await ctx.params;
  const { data } = await admin().from('export_templates').select('*').eq('id', Number(id)).maybeSingle();
  if (!data) return bad('Schedule not found', 404);
  try {
    return NextResponse.json({ ok: true, summary: await runExportTemplate(data) });
  } catch (err) {
    return bad((err as Error).message, 502);
  }
}
