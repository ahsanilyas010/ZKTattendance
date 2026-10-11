import { admin } from './supabase/admin';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface SiteSettings {
  dedupe_window_sec: number;
  company_name: string;
  smtp: SmtpSettings | null;
}

const DEFAULTS: SiteSettings = { dedupe_window_sec: 120, company_name: '', smtp: null };

export async function getSettings(siteId: number): Promise<SiteSettings> {
  const { data, error } = await admin().from('settings').select('key,value').eq('site_id', siteId);
  if (error) throw error;
  const out: SiteSettings = { ...DEFAULTS };
  for (const row of data ?? []) (out as unknown as Record<string, unknown>)[row.key] = row.value;
  return out;
}

export async function setSetting(siteId: number, key: keyof SiteSettings, value: unknown) {
  const { error } = await admin().from('settings').upsert({ site_id: siteId, key, value }, { onConflict: 'site_id,key' });
  if (error) throw error;
}

export async function getSite(siteId: number) {
  const { data, error } = await admin().from('sites').select('id,name,timezone').eq('id', siteId).single();
  if (error) throw error;
  return data as { id: number; name: string; timezone: string };
}
