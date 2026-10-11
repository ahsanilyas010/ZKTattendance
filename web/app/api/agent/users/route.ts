import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { authAgent, isResponse } from '@/lib/agentAuth';
import { addDays, localDate } from '@/lib/attendance';
import { bindUnknownPunches, recompute } from '@/lib/recompute';
import { getSite } from '@/lib/settings';

const Body = z.object({
  device_id: z.number().int(),
  users: z.array(z.object({ user_id: z.string().min(1).max(64), name: z.string().max(100) })).max(5000),
});

/**
 * "Import people from terminal": the agent reports who is enrolled on the device. Anyone whose
 * ID is not in the directory yet is created, so every punch can show a name immediately.
 */
export async function POST(req: Request) {
  const agent = await authAgent(req);
  if (isResponse(agent)) return agent;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, { status: 400 });
  const db = admin();
  const { data: dev } = await db.from('devices').select('id').eq('id', parsed.data.device_id).eq('site_id', agent.site_id).maybeSingle();
  if (!dev) return NextResponse.json({ error: 'unknown device' }, { status: 404 });

  const { data: existing } = await db.from('employees').select('device_user_id').eq('site_id', agent.site_id).not('device_user_id', 'is', null);
  const have = new Set((existing ?? []).map((e) => e.device_user_id as string));
  const fresh = parsed.data.users.filter((u) => !have.has(u.user_id));
  let created = 0;
  const ids: number[] = [];
  for (let i = 0; i < fresh.length; i += 200) {
    const { data, error } = await db.from('employees').insert(fresh.slice(i, i + 200).map((u) => ({
      site_id: agent.site_id, device_user_id: u.user_id, name: u.name.trim() || `ID ${u.user_id}`, department: 'General',
    }))).select('id,device_user_id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const row of data ?? []) { await bindUnknownPunches(agent.site_id, row.id, row.device_user_id); ids.push(row.id); }
    created += data?.length ?? 0;
  }
  if (ids.length) {
    const site = await getSite(agent.site_id);
    const to = localDate(new Date(), site.timezone);
    await recompute(agent.site_id, { from: addDays(to, -60), to, employeeIds: ids });
  }
  return NextResponse.json({ created, already_present: parsed.data.users.length - fresh.length });
}
