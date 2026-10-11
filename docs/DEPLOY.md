# Deploying the cloud side (Supabase + Vercel)

About 20 minutes. You need a Supabase account, a Vercel account and this repository on GitHub.

## 1. Database: the ABPO Command project

This system shares the existing Supabase project **ABPO Command** (ref `uvgekzergvtbvvhvuyyh`) and keeps
everything in its own `attendance` schema, so the call-centre CRM tables in `public` are never touched.

The schema is **already applied** (migrations `attendance_1_tables`, `attendance_2a_grants_rls`,
`attendance_2b_function_storage_seed`). To set up a fresh project instead, run
`supabase/migrations/20261011000000_init.sql` in the SQL Editor.

**One manual step:** *Project Settings → API → Exposed schemas* → add `attendance` and save. Without it the
dashboard cannot reach the tables.

Optional sample data to try the dashboard before the terminal is connected: run `supabase/seed_demo.sql`.

## 2. Choose the attendance administrator

Access is granted by a flag on an existing login, not by who can sign in. Pick the account you will use
(for example your own) and run, with that email:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'
where email = 'you@example.com';
```

Nobody else gets in: CRM users keep their CRM roles (stored in `profiles`) and see no attendance data,
and a normal sign-up cannot set this flag. Sign out and in again so the new flag is in your session.
Leave *Allow new users to sign up* as it is, because the CRM shares that setting.

## 3. Collect the keys

**Project Settings → API Keys:** the project URL (`https://uvgekzergvtbvvhvuyyh.supabase.co`), the
*publishable* key, and the *secret* key. The secret key bypasses all security rules. Put it only in
Vercel's environment variables, never in the browser or the repository.

## 4. Deploy the dashboard

1. Vercel → **Add New → Project →** import this repository. Set **Root Directory** to `web`.
2. Add environment variables (see `.env.example`):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key |
   | `CRON_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
   | `ACCESS_KEY` | optional: a passphrase you choose (16+ characters) for key sign-in, see below |

3. Deploy, then open the URL and sign in.

### Sign in with a shared access key (optional)

Set `ACCESS_KEY` in Vercel and redeploy. The login page then asks for just that key: type it once per browser and
that browser stays signed in for 90 days (a signed, HttpOnly cookie; the key itself is never stored in the browser).
Email and password still works under *Use email and password instead*, which is the recommended route for
any person you need to tell apart. Treat the key like a password: share it only with people who should have
full access, pick a long passphrase, and change it in Vercel to sign every browser out. Wrong keys are slowed down
and limited to 8 tries per 10 minutes per client, but that is a speed bump rather than a lock, so length matters.

**A variable only takes effect on a deployment created after you saved it.** After adding or changing `ACCESS_KEY`
(or any other variable), redeploy: Deployments → latest → ⋯ → Redeploy, or push any commit. If the login page says
"Access key sign-in is not set up", the running deployment predates the variable, or the key is under 16 characters.

## 5. Start the scheduler (needed for absence checks, alerts, scheduled exports)

Vercel's free plan only allows a daily cron, so a five-minute heartbeat comes from Supabase instead.
**Database → Extensions:** `pg_cron` and the vault are already on in this project; enable `pg_net`. Then run (replace the two values):

```sql
select vault.create_secret('<the same CRON_SECRET>', 'attendance_cron_secret');

select cron.schedule('attendance-tick', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://<your-app>.vercel.app/api/jobs/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'attendance_cron_secret')
    ),
    timeout_milliseconds := 55000
  );
$$);
```

Check it later with `select * from cron.job_run_details order by start_time desc limit 5;`.
To stop it: `select cron.unschedule('attendance-tick');`.

## 6. Verify

```bash
cd web && node scripts/smoke.mjs https://<your-app>.vercel.app <CRON_SECRET>
```

All lines should say `OK`. Then in the dashboard: **Settings →** set time zone and SMTP, send a test email;
**Devices & sync →** create the agent key and continue with [AGENT-SETUP](AGENT-SETUP.md).

## Notes

* **Shared project:** back up and upgrade it as one unit with the CRM. Attendance tables are dropped cleanly with `drop schema attendance cascade` if you ever move them.
* **Backups:** check the project's plan for point-in-time backups, or schedule `pg_dump`, once the data matters.
* **Limits:** the recompute service sends employee IDs in one request, fine up to roughly a thousand employees per site.
* **Secrets:** the SMTP password is stored in the `settings` table, readable only with the secret key. It is never returned to the browser.
