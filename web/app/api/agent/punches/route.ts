import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { authAgent, isResponse, sha256 } from '@/lib/agentAuth';
import { getSite } from '@/lib/settings';
import { recompute } from '@/lib/recompute';
import { localDate } from '@/lib/attendance';

const Body = z.object({
  punches: z.array(z.object({
    device_id: z.number().int(),
    device_user_id: z.string().min(1).max(64),
    punched_at: z.string().datetime({ offset: true }),
    verify_method: z.string().max(32).nullish(),
    punch_type: z.number().int().nullish(),
  })).max(1000),
});

export async function POST(req: Request) {
  const agent = await authAgent(req);
  if (isResponse(agent)) return agent;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, { status: 400 });

  const db = admin();
  const { punches } = parsed.data;
  if (punches.length === 0) return NextResponse.json({ accepted: [], inserted: 0 });

  const { data: devs } = await db.from('devices').select('id').eq('site_id', agent.site_id);
  const okDevices = new Set((devs ?? []).map((d) => d.id));
  const { data: emps } = await db.from('employees').select('id,device_user_id').eq('site_id', agent.site_id).not('device_user_id', 'is', null);
  const empByUser = new Map((emps ?? []).map((e) => [e.device_user_id as string, e.id as number]));

  const horizon = Date.now() + 24 * 3600_000;
  const accepted: string[] = [];
  const rows = [];
  for (const p of punches) {
    const at = new Date(p.punched_at);
    if (!okDevices.has(p.device_id) || at.getTime() > horizon) continue; // wrong site or a clearly bogus clock
    const key = sha256(`${p.device_id}|${p.device_user_id}|${at.toISOString()}`);
    accepted.push(key);
    rows.push({
      site_id: agent.site_id, device_id: p.device_id, employee_id: empByUser.get(p.device_user_id) ?? null,
      device_user_id: p.device_user_id, punched_at: at.toISOString(), verify_method: p.verify_method ?? null,
      punch_type_raw: p.punch_type ?? null, dedupe_key: key,
    });
  }

  let inserted: { employee_id: number | null; punched_at: string; device_id: number }[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await db.from('raw_punches')
      .upsert(rows.slice(i, i + 500), { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('employee_id,punched_at,device_id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = inserted.concat(data ?? []);
  }

  // Latest punch per device, for the dashboard's "last punch" display.
  const latest = new Map<number, string>();
  for (const r of inserted) if (!latest.has(r.device_id) || r.punched_at > latest.get(r.device_id)!) latest.set(r.device_id, r.punched_at);
  await Promise.all([...latest].map(([id, ts]) => db.from('devices').update({ last_punch_at: ts }).eq('id', id).lt('last_punch_at', ts)));
  await Promise.all([...latest].map(([id, ts]) => db.from('devices').update({ last_punch_at: ts }).eq('id', id).is('last_punch_at', null)));

  // Recompute only the employees and days touched by genuinely new punches.
  const known = inserted.filter((r) => r.employee_id != null);
  if (known.length) {
    const site = await getSite(agent.site_id);
    const dates = known.map((r) => localDate(new Date(r.punched_at), site.timezone)).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const ids = [...new Set(known.map((r) => r.employee_id as number))];
    await recompute(agent.site_id, { from, to, employeeIds: ids });
  }
  return NextResponse.json({ accepted, inserted: inserted.length });
}
