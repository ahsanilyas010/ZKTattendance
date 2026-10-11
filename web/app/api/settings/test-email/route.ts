import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSettings } from '@/lib/settings';
import { sendMail } from '@/lib/mailer';
import { bad, currentSiteId, requireAdmin } from '@/lib/auth';

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = z.object({ to: z.string().email() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return bad('Enter a valid email address.');
  try {
    const s = await getSettings(await currentSiteId());
    await sendMail(s.smtp, { to: [body.data.to], subject: 'Attendance system: test email', text: 'Email is set up correctly. Alerts and scheduled exports will be sent from this address.' });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return bad((err as Error).message, 502);
  }
}
