import nodemailer from 'nodemailer';
import type { SmtpSettings } from './settings';

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export class MailNotConfigured extends Error {
  constructor() {
    super('Email is not set up yet. Add your SMTP details under Settings.');
  }
}

export async function sendMail(smtp: SmtpSettings | null, mail: Mail): Promise<void> {
  if (!smtp?.host) throw new MailNotConfigured();
  if (mail.to.length === 0) throw new Error('No recipients');
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15_000, socketTimeout: 30_000,
  });
  await transport.sendMail({
    from: smtp.from || smtp.user, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
    attachments: mail.attachments,
  });
}

/** Replace {{var}} placeholders; unknown variables are left blank. */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}
export { parseRecipients } from './ranges';
