import { NextResponse } from 'next/server';
import { z } from 'zod';
import { admin } from '@/lib/supabase/admin';
import { getSettings, setSetting, type SmtpSettings } from '@/lib/settings';
import { bad, currentSiteId, requireAdmin } from '@/lib/auth';

/** Settings for the form. The SMTP password never leaves the server: only whether one is set. */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const siteId = await currentSiteId();
  const [s, site] = await Promise.all([getSettings(siteId), admin().from('sites').select('name,timezone').eq('id', siteId).single()]);
  const { pass, ...smtp } = s.smtp ?? { host: '', port: 587, secure: false, user: '', pass: '', from: '' };
  return NextResponse.json({
    dedupe_window_sec: s.dedupe_window_sec, company_name: s.company_name, site: site.data,
    smtp: { ...smtp, has_password: !!pass },
  });
}

const Body = z.object({
  dedupe_window_sec: z.number().int().min(0).max(3600),
  company_name: z.string().max(120),
  site_name: z.string().min(1).max(120),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone'),
  smtp: z.object({
    host: z.string().max(200), port: z.number().int().min(1).max(65535), secure: z.boolean(),
    user: z.string().max(200), pass: z.string().max(500).optional(), from: z.string().max(200),
  }),
});

export async function PUT(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid settings');
  const b = parsed.data;
  const siteId = await currentSiteId();
  const existing = await getSettings(siteId);
  const smtp: SmtpSettings = { ...b.smtp, pass: b.smtp.pass ? b.smtp.pass : existing.smtp?.pass ?? '' };
  await setSetting(siteId, 'dedupe_window_sec', b.dedupe_window_sec);
  await setSetting(siteId, 'company_name', b.company_name);
  await setSetting(siteId, 'smtp', smtp);
  const { error } = await admin().from('sites').update({ name: b.site_name, timezone: b.timezone }).eq('id', siteId);
  if (error) return bad(error.message, 500);
  return NextResponse.json({ ok: true });
}
