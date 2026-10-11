export type AgentLike = { last_seen_at: string | null; poll_interval_sec: number };

/** An agent is healthy if it checked in within 3 poll intervals (min 2 minutes). */
export function agentState(a: AgentLike | undefined, now = Date.now()): 'online' | 'stale' | 'never' {
  if (!a?.last_seen_at) return 'never';
  const limit = Math.max(3 * a.poll_interval_sec, 120) * 1000;
  return now - new Date(a.last_seen_at).getTime() < limit ? 'online' : 'stale';
}
