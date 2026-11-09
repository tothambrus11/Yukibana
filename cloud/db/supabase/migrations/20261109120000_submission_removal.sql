-- Removing a submission.
--
-- Until now submissions were append-only: no update or delete path existed,
-- because a submission is evidence of what a student handed in and when.
-- That left staff no way out of a mistake: a test upload, a hand-in sent to
-- the wrong project, an archive that should never have been shared. Every
-- version stays a row and the newest is the one assessed, so a wrong newest
-- version could only be buried under another.
--
-- The rule (decided 2026-11):
--
--   * Staff of the edition, owners and assistants alike, remove any of its
--     submissions, at any time. Assistants are the ones who sort out
--     hand-ins day to day, so they need it as much as an owner does.
--   * Students do not remove anything, their own submissions included. A
--     student who sent the wrong thing sends the right one, which becomes
--     the newest and so the one assessed; what they handed in stays
--     evidence, and only staff can take it back.
--   * Removal is a hard delete. The row goes, and the Worker deletes the
--     archive from the bucket once the row is gone. What is left is the
--     audit_log row this function writes in the same transaction: who
--     removed which submission, whose it was, when it had been sent, and
--     the archive's size and SHA-256, so the evidence that something was
--     handed in and taken back survives the body itself.
--
-- The table still has no delete grant and no delete policy: this function
-- is the only way a row leaves, so the rule above is written once.

set local lock_timeout = '10s';
set local statement_timeout = '5min';

-- Whether the caller may remove `submission`: staff of its edition. False
-- (never null) for a submission that does not exist, and for everyone else,
-- its author included. Pages ask it before drawing a remove button, so
-- nobody sees one that would only be refused.
create or replace function app.may_remove_submission(submission uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select app.is_staff(s.edition_id)
    from public.submission s
    where s.submission_id = may_remove_submission.submission
  ), false)
$$;
revoke execute on function app.may_remove_submission(uuid) from public, anon;
grant execute on function app.may_remove_submission(uuid) to authenticated;

-- Removes `submission` and answers its bucket key, for the Worker to delete
-- the archive with. Raises P0002 for a submission the caller cannot read
-- (none by that id, or a classmate's: the two are told apart for nobody),
-- and 42501, with a sentence for the person, for one they can read but may
-- not remove: their own, as a student.
create or replace function app.remove_submission(submission uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.submission%rowtype;
begin
  select * into s from public.submission x
  where x.submission_id = remove_submission.submission
    and (x.author_id = (select auth.uid()) or app.is_staff(x.edition_id));
  if s.submission_id is null then
    raise exception 'No such submission.' using errcode = 'P0002';
  end if;
  if not app.is_staff(s.edition_id) then
    raise exception 'Only the course staff can remove a submission. To replace it, submit again: the newest submission is the one assessed.' using errcode = '42501';
  end if;
  delete from public.submission x where x.submission_id = s.submission_id;
  perform app.audit('remove_submission', jsonb_build_object(
    'submission_id', s.submission_id,
    'edition_id', s.edition_id,
    'project_id', s.project_id,
    'author_id', s.author_id,
    'submitted_at', s.submitted_at,
    'object_key', s.object_key,
    'byte_size', s.byte_size,
    'sha256', encode(s.sha256, 'hex'),
    'base_release_id', s.base_release_id));
  return s.object_key;
end
$$;
revoke execute on function app.remove_submission(uuid) from public, anon;
grant execute on function app.remove_submission(uuid) to authenticated;

-- A removal is news to the same people as an arrival: the edition's staff
-- and the author, wherever they have a page open. The trigger function now
-- reads whichever row the operation has.
create or replace function app.signal_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.submission%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform app.signal('edition:' || r.edition_id || ':staff', tg_table_name);
  perform app.signal('user:' || r.author_id, tg_table_name);
  return null;
end
$$;
revoke execute on function app.signal_submission() from public, anon, authenticated;
create trigger submission_removed_signal after delete on public.submission
  for each row execute function app.signal_submission();
