import { supabaseServer } from '@/lib/supabase/server';
import { Nav, SignOut } from '@/components/nav';
import { SiteProvider } from '@/components/site';
import { agentState } from '@/lib/agentStatus';
import { ago } from '@/lib/format';
import { listAgents } from '@/lib/agents';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const [{ data: site }, agents, { count: unbound }] = await Promise.all([
    sb.from('sites').select('id,name,timezone').order('id').limit(1).single(),
    listAgents(),
    sb.from('employees').select('id', { count: 'exact', head: true }).eq('status', 'active').is('device_user_id', null),
  ]);
  const agent = agents[0];
  const st = agentState(agent);
  const dot = st === 'online' ? 'var(--ok)' : st === 'stale' ? 'var(--bad)' : 'var(--idle)';
  const label = st === 'online' ? 'Agent online' : st === 'stale' ? 'Agent offline' : 'No agent yet';

  return (
    <SiteProvider value={site ?? { id: 1, name: '', timezone: 'UTC' }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <div className="logo">A</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <strong style={{ fontSize: 14 }}>Attendance</strong>
              <span className="sub">{site?.name || 'Admin'}</span>
            </div>
          </div>
          <Nav badges={{ '/employees': unbound ?? 0 }} />
          <div className="agentbox">
            <div className="row" style={{ gap: 7, fontWeight: 500 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />{label}
            </div>
            <div className="sub mono">{agent?.last_seen_at ? `Synced ${ago(agent.last_seen_at)} ago` : 'Not synced'}</div>
            <div style={{ marginTop: 6 }}><SignOut /></div>
          </div>
        </aside>
        <main className="main"><div className="wrap">{children}</div></main>
      </div>
    </SiteProvider>
  );
}
