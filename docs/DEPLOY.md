# Deploying the cloud side (Supabase + Vercel)

About 20 minutes. You need a Supabase account, a Vercel account and this repository on GitHub.

## 1. Create the database

1. In Supabase, **New project** (name it e.g. `attendance`, pick the region nearest the site). Save the database password.
2. Open **SQL Editor**, paste the contents of `supabase/migrations/20261011000000_init.sql`, and run it.
   (Or with the CLI: `supabase link --project-ref <ref> && supabase db push`.)
3. Optional, to try the dashboard with sample data: run `supabase/seed_demo.sql` the same way.

## 2. Create the admin login

1. **Authentication → Users → Add user → Create new user.** Enter your email and a strong password, tick *Auto Confirm User*.
2. Mark that user as the administrator. In the SQL Editor run (with your email):

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'
   where email = 'you@example.com';
   ```

   Only this flag grants access to the data; a normal sign-up cannot set it.
3. **Authentication → Sign In / Providers →** turn **off** *Allow new users to sign up*.

## 3. Collect the keys

**Project Settings → API Keys:** the project URL, the *publishable* key, and the *secret* key.
The secret key bypasses all security rules. Put it only in Vercel's environment variables.

## 4. Deploy the dashboard

1. Vercel → **Add New → Project →** import this repository. Set **Root Directory** to `web`.
2. Add environment variables (see `.env.example`):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key |
   | `CRON_SECRET` | a long random string, e.g. `openssl rand -hex 32` |

3. Deploy, then open the URL and sign in.

## 5. Start the scheduler (needed for absence checks, alerts, scheduled exports)

Vercel's free plan only allows a daily cron, so a five-minute heartbeat comes from Supabase instead.
**Database → Extensions:** enable `pg_cron` and `pg_net`. Then run (replace the two values):

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

* **Backups:** Supabase free projects have no point-in-time backups. Use a paid plan, or schedule `pg_dump`, once the data matters.
* **Limits:** the recompute service sends employee IDs in one request, fine up to roughly a thousand employees per site.
* **Secrets:** the SMTP password is stored in the `settings` table, readable only with the secret key. It is never returned to the browser.
