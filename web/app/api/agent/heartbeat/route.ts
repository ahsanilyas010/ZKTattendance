import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { authAgent, isResponse } from '@/lib/agentAuth';

const Body = z.object({
  version: z.string().max(32).optional(),
  hostname: z.string().max(128).optional(),
  queue_depth: z.number().int().min(0).default(0),
  last_error: z.string().max(500).nullish(),
  devices: z.array(z.object({
    device_id: z.number().int(),
    reachable: z.boolean(),
    error: z.string().max(500).nullish(),
    serial: z.string().max(64).nullish(),
    model: z.string().max(64).nullish(),
    enrolled_count: z.number().int().nullish(),
    clock_drift_sec: z.number().int().nullish(),
  })).default([]),
  command_results: z.array(z.object({ id: z.number().int(), ok: z.boolean(), result: z.string().max(500).nullish() })).default([]),
  enrolled_employee_ids: z.array(z.number().int()).default([]),
});

export async function POST(req: Request) {
  const agent = await authAgent(req);
  if (isResponse(agent)) return agent;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, { status: 400 });
  const b = parsed.data;
  const db = admin();
  const now = new Date().toISOString();

  await db.from('agents').update({
    last_seen_at: now, version: b.version ?? null, hostname: b.hostname ?? null,
    queue_depth: b.queue_depth, last_error: b.last_error ?? null,
  }).eq('id', agent.id);

  const { data: mine } = await db.from('devices').select('id,consecutive_failures').eq('site_id', agent.site_id);
  const failures = new Map((mine ?? []).map((d) => [d.id as number, d.consecutive_failures as number]));
  for (const d of b.devices) {
    if (!failures.has(d.device_id)) continue; // not this site's device
    if (d.reachable) {
      await db.from('devices').update({
        status: 'online', consecutive_failures: 0, last_seen_at: now, last_error: null,
        ...(d.serial ? { serial: d.serial } : {}), ...(d.model ? { model: d.model } : {}),
        enrolled_count: d.enrolled_count ?? null, clock_drift_sec: d.clock_drift_sec ?? null,
      }).eq('id', d.device_id);
    } else {
      const n = (failures.get(d.device_id) ?? 0) + 1;
      // Two consecutive failed polls before declaring offline, so one blip does not alert.
      await db.from('devices').update({
        consecutive_failures: n, last_error: d.error ?? 'unreachable', ...(n >= 2 ? { status: 'offline' } : {}),
      }).eq('id', d.device_id);
    }
  }

  for (const c of b.command_results) {
    await db.from('device_commands').update({ status: c.ok ? 'done' : 'failed', result: c.result ?? null, finished_at: now })
      .eq('id', c.id).eq('status', 'pending');
  }
  if (b.enrolled_employee_ids.length) {
    await db.from('employees').update({ enrollment_pending: false })
      .eq('site_id', agent.site_id).in('id', b.enrolled_employee_ids);
  }
  return NextResponse.json({ ok: true });
}
