-- What a fresh local database contains, so the app has something to show
-- after `supabase db reset`. Local only: seeds never run against a deployed
-- database. Log in with GitHub or by email code, then make yourself the admin
-- with `node cloud/dev/scripts/local-admin.mjs you@yukibana.local`. The people below log in
-- by code too: ask for one on the login page and read it in the local mail
-- catcher, http://127.0.0.1:54324.

-- The Worker's connection password, for local development only. In a
-- deployed environment cloud/db/ops/bootstrap.sql sets it from a secret.
alter role yukibana_app password 'yukibana';

-- A teacher, an assistant, two students, a course with one edition and one
-- published project. The addresses are not real; enrol your own GitHub
-- address to see the edition as a student.
do $$
declare
  teacher uuid := tests.create_user('teacher@yukibana.local', 'Ada Teacher', 'ada');
  alice   uuid := tests.create_user('alice@yukibana.local', 'Alice Student', 'alice');
  bob     uuid := tests.create_user('bob@yukibana.local', 'Bob Student', 'bob');
  ta      uuid := tests.create_user('ta@yukibana.local', 'Tom Assistant', 'tom');
  cid uuid;
  eid uuid;
begin
  update public.app_user set role = 'teacher' where user_id = teacher;

  perform tests.authenticate(teacher);
  cid := app.create_course('CS-101', 'Introduction to Programming');
  eid := app.create_edition(cid, '2026 autumn');
  perform app.enrol(eid, 'alice@yukibana.local');
  perform app.enrol(eid, 'bob@yukibana.local');
  perform app.enrol(eid, 'ta@yukibana.local', 'assistant');
  insert into public.project (edition_id, slug, title, kind, available_after, deadline)
  values (eid, 'warmup', 'Warm-up: a Rust calculator', 'rust-cargo', now() - interval '1 day', now() + interval '30 days');
  perform tests.clear_auth();
end
$$;
