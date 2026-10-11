// Data forwarder for access-key sessions. Access-key users have no Supabase user session, so row-level
// security cannot recognise them; this route checks the signed access cookie, then forwards the browser's
// data calls to Supabase with the server key, limited to the attendance schema and its non-secret tables.
// Anyone without a valid access cookie (or when no ACCESS_KEY is set) gets 404.
import { hasAccessSession } from '@/lib/accessSession';
import { admin } from '@/lib/supabase/admin';
import { AGENT_HEALTH_COLUMNS } from '@/lib/agents';

export const dynamic = 'force-dynamic';

// `settings` (SMTP password) and `agents` (key hashes) are deliberately absent.
const TABLES = new Set(['sites', 'devices', 'device_commands', 'shift_schedules', 'employees', 'raw_punches',
  'daily_attendance', 'leave_entries', 'holidays', 'alert_rules', 'alert_events', 'export_templates', 'export_jobs']);
const PHOTO_BUCKET = 'employee-photos';

const notFound = () => Response.json({ message: 'not found' }, { status: 404 });

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  if (!(await hasAccessSession())) return notFound();
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p === '.')) return notFound();
  const [api, version, first, second] = path;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const search = new URL(req.url).search;

  // Agent health without key hashes (stands in for the admin-only list_agents() call).
  if (api === 'rest' && version === 'v1' && first === 'rpc' && second === 'list_agents') {
    const { data } = await admin().from('agents').select(AGENT_HEALTH_COLUMNS).order('id');
    return Response.json(data ?? []);
  }

  let upstream: string;
  const headers = new Headers({ apikey: key, authorization: `Bearer ${key}` });
  if (api === 'rest' && version === 'v1' && first && TABLES.has(first) && path.length === 3) {
    upstream = `${base}/rest/v1/${first}${search}`;
    headers.set('accept-profile', 'attendance');
    headers.set('content-profile', 'attendance');
  } else if (api === 'storage' && version === 'v1' && path[2] === 'object' && path.slice(3).includes(PHOTO_BUCKET)) {
    upstream = `${base}/${path.join('/')}${search}`;
  } else {
    return notFound();
  }
  for (const h of ['content-type', 'prefer', 'range', 'accept', 'x-upsert', 'cache-control']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const res = await fetch(upstream, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual' });
  const out = new Headers();
  for (const h of ['content-type', 'content-range', 'content-length', 'cache-control']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out });
}

export const GET = forward, POST = forward, PATCH = forward, PUT = forward, DELETE = forward, HEAD = forward;
