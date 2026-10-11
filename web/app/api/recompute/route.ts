import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { addDays, localDate } from '@/lib/attendance';
import { bindUnknownPunches, recompute } from '@/lib/recompute';
import { getSite } from '@/lib/settings';
import { bad, currentSiteId, requireAdmin } from '@/lib/auth';

/**
 * Call after anything that changes past results: binding an employee to a device ID, editing shifts,
 * leave, holidays or the duplicate window. Optionally scoped to one employee.
 */
export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = z.object({ employeeId: z.number().int().optional(), days: z.number().int().min(1).max(366).default(60) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return bad('Invalid request');
  const siteId = await currentSiteId();
  const site = await getSite(siteId);
  const to = localDate(new Date(), site.timezone);
  const from = addDays(to, -(body.data.days - 1));
  let bound = 0;
  if (body.data.employeeId) {
    const { data: e } = await admin().from('employees').select('device_user_id').eq('id', body.data.employeeId).single();
    if (e?.device_user_id) bound = await bindUnknownPunches(siteId, body.data.employeeId, e.device_user_id);
  }
  const rows = await recompute(siteId, { from, to, employeeIds: body.data.employeeId ? [body.data.employeeId] : undefined });
  return NextResponse.json({ ok: true, rows, bound_punches: bound });
}
