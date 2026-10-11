import { admin } from './supabase/admin';

export interface AgentHealth {
  id: number; site_id: number; name: string; poll_interval_sec: number; last_seen_at: string | null;
  version: string | null; hostname: string | null; queue_depth: number; last_error: string | null;
}

export const AGENT_HEALTH_COLUMNS = 'id,site_id,name,poll_interval_sec,last_seen_at,version,hostname,queue_depth,last_error';

/** Agent health without key hashes. Server-only; call only from pages already behind sign-in. */
export async function listAgents(): Promise<AgentHealth[]> {
  const { data } = await admin().from('agents').select(AGENT_HEALTH_COLUMNS).order('id');
  return (data ?? []) as AgentHealth[];
}
