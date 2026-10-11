import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { admin } from '@/lib/supabase/admin';
import { getSite } from '@/lib/settings';
import { recompute } from '@/lib/recompute';
import { addDays, localDate, localParts } from '@/lib/attendance';
import { evaluateAlerts } from '@/lib/alerts';
import { runDueExports } from '@/lib/scheduledExports';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/**
 * Called every few minutes (Supabase pg_cron -> pg_net, plus a daily Vercel cron as a backstop).
 * Idempotent: it recomputes today, flips stale devices to "unknown", sends due alerts and exports.
 */
async function tick(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = admin();
  const now = new Date();
  const { data: sites } = await db.from('sites').select('id');
  const report: Record<string, unknown>[] = [];

  for (const { id } of sites ?? []) {
    const site = await getSite(id);
    const today = localDate(now, site.timezone);
    const out: Record<string, unknown> = { site: id };
    try {
      // Absent/late flags change with the clock, not only with new punches, so refresh today every tick.
      // Around 02:00 local also re-derive the trailing days (picks up late edits and settings changes).
      const p = localParts(now, site.timezone);
      const nightly = p.h === 2 && p.min < 10;
      await recompute(id, { from: nightly ? addDays(today, -3) : today, to: today, now });

      // If every agent has gone quiet, "online" is no longer trustworthy.
      const { data: agents } = await db.from('agents').select('last_seen_at,poll_interval_sec').eq('site_id', id);
      const fresh = (agents ?? []).some((a) => a.last_seen_at && now.getTime() - new Date(a.last_seen_at).getTime() < Math.max(3 * a.poll_interval_sec, 120) * 1000);
      if (!fresh) await db.from('devices').update({ status: 'unknown' }).eq('site_id', id).eq('status', 'online');

      out.alerts = (await evaluateAlerts(id, now)).sent;
      out.exports = await runDueExports(id, now);
    } catch (err) {
      out.error = (err as Error).message;
    }
    report.push(out);
  }
  return NextResponse.json({ ok: true, at: now.toISOString(), report });
}

export const GET = tick;
export const POST = tick;
