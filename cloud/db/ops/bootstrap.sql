-- Per-environment values that a migration cannot carry because they are
-- secrets or differ by environment. Idempotent: the deploy workflow runs it
-- after every `supabase db push`.
--
--   psql "$SUPABASE_DB_URL" -v app_password="$APP_DB_PASSWORD" -v admin_email="$FIRST_ADMIN_EMAIL" -f cloud/db/ops/bootstrap.sql

alter role yukibana_app password :'app_password';

-- Promotes the first admin, once; a no-op ever after, and a no-op with a
-- notice while that address has not logged in yet. On a brand-new
-- environment: deploy, log in with GitHub, deploy again (or run this file).
select app.bootstrap_admin(:'admin_email');
