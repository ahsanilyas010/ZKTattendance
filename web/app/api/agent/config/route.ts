import { NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/admin';
import { authAgent, isResponse } from '@/lib/agentAuth';
import { getSettings, getSite } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const agent = await authAgent(req);
  if (isResponse(agent)) return agent;
  const db = admin();
  const [site, settings, devices, enrol] = await Promise.all([
    getSite(agent.site_id),
    getSettings(agent.site_id),
    db.from('devices').select('id,name,ip,port,comm_password,enabled').eq('site_id', agent.site_id).eq('enabled', true),
    db.from('employees').select('id,name,device_user_id').eq('site_id', agent.site_id)
      .eq('enrollment_pending', true).eq('status', 'active').not('device_user_id', 'is', null),
  ]);
  const deviceIds = (devices.data ?? []).map((d) => d.id);
  const commands = deviceIds.length
    ? (await db.from('device_commands').select('id,device_id,kind').eq('status', 'pending').in('device_id', deviceIds)).data ?? []
    : [];
  return NextResponse.json({
    timezone: site.timezone,
    poll_interval_sec: agent.poll_interval_sec,
    dedupe_window_sec: settings.dedupe_window_sec,
    devices: devices.data ?? [],
    enrollments: (enrol.data ?? []).map((e) => ({ employee_id: e.id, device_user_id: e.device_user_id, name: e.name })),
    commands,
  });
}
