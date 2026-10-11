// Post-deploy smoke test:  node scripts/smoke.mjs https://your-app.vercel.app  <CRON_SECRET>
// Confirms the deployment is reachable and that every protected endpoint refuses anonymous callers.
const [base, cronSecret] = process.argv.slice(2);
if (!base) { console.error('usage: node scripts/smoke.mjs <https://your-app> [CRON_SECRET]'); process.exit(2); }

let failed = 0;
async function check(name, path, init, expectStatus) {
  const res = await fetch(base.replace(/\/$/, '') + path, { redirect: 'manual', ...init });
  const ok = expectStatus.includes(res.status);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} -> ${res.status} (expected ${expectStatus.join(' or ')})`);
}

await check('login page loads', '/login', {}, [200]);
await check('dashboard redirects signed-out visitors', '/', {}, [307, 308]);
await check('admin API refuses anonymous callers', '/api/settings', {}, [401]);
await check('Excel export refuses anonymous callers', '/api/export?from=2026-01-01&to=2026-01-02', {}, [401]);
await check('agent API refuses a missing key', '/api/agent/config', {}, [401]);
await check('agent API refuses a wrong key', '/api/agent/config', { headers: { 'x-agent-key': 'zka_wrong' } }, [401]);
await check('cron endpoint refuses no secret', '/api/jobs/tick', {}, [401]);
if (cronSecret) {
  await check('cron endpoint accepts the secret', '/api/jobs/tick', { headers: { authorization: `Bearer ${cronSecret}` } }, [200]);
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
