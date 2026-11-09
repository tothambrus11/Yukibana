-- Removing a submission: staff of the edition, owners and assistants, at
-- any time; nobody else, the author included; and every removal leaves an
-- audit row.
begin;
select plan(20);

select tests.create_user('owner@example.com', 'Owner', 'owner');
update public.app_user set role = 'teacher' where user_id = tests.uid('owner@example.com');
select tests.create_user('ta@example.com', 'Assistant', 'ta');
select tests.create_user('alice@example.com', 'Alice', 'alice');
select tests.create_user('bob@example.com', 'Bob', 'bob');
select tests.create_user('outsider@example.com', 'Outsider', 'outsider');
select tests.create_user('other-owner@example.com', 'Other owner', 'other');
update public.app_user set role = 'teacher' where user_id = tests.uid('other-owner@example.com');

select tests.authenticate(tests.uid('other-owner@example.com'));
select app.create_course('T-RM2', 'Elsewhere');
select app.create_edition((select course_id from public.course where code = 'T-RM2'), '2026');

select tests.authenticate(tests.uid('owner@example.com'));
select app.create_course('T-RM', 'Removal');
select app.create_edition((select course_id from public.course where code = 'T-RM'), '2026');
select app.enrol(tests.edition('T-RM', '2026'), 'ta@example.com', 'assistant');
select app.enrol(tests.edition('T-RM', '2026'), 'alice@example.com');
select app.enrol(tests.edition('T-RM', '2026'), 'bob@example.com');
insert into public.project (edition_id, slug, title, kind, available_after, deadline, closes_at)
values (tests.edition('T-RM', '2026'), 'rm-open', 'Open', 'rust-cargo', now() - interval '3 days', now() + interval '1 day', now() + interval '2 days');

-- Alice hands in three versions while the project is open.
select tests.authenticate(tests.uid('alice@example.com'));
insert into public.submission (submission_id, edition_id, project_id, author_id, object_key, byte_size, sha256)
values ('00000000-0000-4000-8000-000000000001', tests.edition('T-RM', '2026'), tests.project('rm-open'), tests.uid('alice@example.com'),
        'submissions/rm1', 10, decode(repeat('ab', 32), 'hex')),
       ('00000000-0000-4000-8000-000000000002', tests.edition('T-RM', '2026'), tests.project('rm-open'), tests.uid('alice@example.com'),
        'submissions/rm2', 11, decode(repeat('cd', 32), 'hex')),
       ('00000000-0000-4000-8000-000000000003', tests.edition('T-RM', '2026'), tests.project('rm-open'), tests.uid('alice@example.com'),
        'submissions/rm3', 12, decode(repeat('ef', 32), 'hex'));

-- The author may not remove their own, even while the project is open.
select ok(not app.may_remove_submission('00000000-0000-4000-8000-000000000001'), 'a student may not remove their own submission');
select throws_ok($$ select app.remove_submission('00000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'and is refused, with a reason');
select throws_ok($$ delete from public.submission $$, '42501', null, 'nor delete the row directly');

-- Those who cannot read it cannot tell it exists.
select tests.authenticate(tests.uid('bob@example.com'));
select ok(not app.may_remove_submission('00000000-0000-4000-8000-000000000001'), 'a classmate may not remove Alice''s submission');
select throws_ok($$ select app.remove_submission('00000000-0000-4000-8000-000000000001') $$,
  'P0002', 'No such submission.', 'and is told only that there is no such submission');
select tests.authenticate(tests.uid('outsider@example.com'));
select throws_ok($$ select app.remove_submission('00000000-0000-4000-8000-000000000001') $$,
  'P0002', 'No such submission.', 'neither can someone not enrolled');
select tests.authenticate(tests.uid('other-owner@example.com'));
select ok(not app.may_remove_submission('00000000-0000-4000-8000-000000000001'), 'nor an owner of another edition');
select throws_ok($$ select app.remove_submission('00000000-0000-4000-8000-000000000001') $$,
  'P0002', 'No such submission.', 'who is refused the same way');
select is(app.may_remove_submission('00000000-0000-4000-0000-00000000dead'), false, 'a submission that does not exist is not removable');

-- Staff remove any submission of their edition, and only through the function.
select tests.authenticate(tests.uid('ta@example.com'));
select throws_ok($$ delete from public.submission $$, '42501', null, 'staff cannot delete rows directly either');
select ok(app.may_remove_submission('00000000-0000-4000-8000-000000000001'), 'an assistant may remove a student''s submission');
select is(app.remove_submission('00000000-0000-4000-8000-000000000001'), 'submissions/rm1', 'removing it answers the archive''s key');
select is_empty($$ select 1 from public.submission where submission_id = '00000000-0000-4000-8000-000000000001' $$, 'and the row is gone');
select is((select count(*) from public.submission), 2::bigint, 'the other versions stay');
select throws_ok($$ select app.remove_submission('00000000-0000-4000-8000-000000000001') $$,
  'P0002', null, 'removing it again finds nothing');

-- After the project closes, staff still may.
select tests.authenticate(tests.uid('owner@example.com'));
update public.project set closes_at = now() - interval '1 second', deadline = now() - interval '2 seconds' where slug = 'rm-open';
select ok(app.may_remove_submission('00000000-0000-4000-8000-000000000002'), 'an owner may remove a submission to a closed project');
select is(app.remove_submission('00000000-0000-4000-8000-000000000002'), 'submissions/rm2', 'and does');
select tests.authenticate(tests.uid('ta@example.com'));
select is(app.remove_submission('00000000-0000-4000-8000-000000000003'), 'submissions/rm3', 'and so does an assistant');

-- Each removal is written down, with what was removed; refusals are not.
select tests.clear_auth();
select results_eq(
  $$ select actor, subject->>'submission_id', subject->>'author_id', subject->>'sha256', (subject->>'byte_size')::bigint
     from public.audit_log where action = 'remove_submission' and subject->>'edition_id' = tests.edition('T-RM', '2026')::text order by subject->>'submission_id' $$,
  $$ values (tests.uid('ta@example.com'), '00000000-0000-4000-8000-000000000001', tests.uid('alice@example.com')::text, repeat('ab', 32), 10::bigint),
            (tests.uid('owner@example.com'), '00000000-0000-4000-8000-000000000002', tests.uid('alice@example.com')::text, repeat('cd', 32), 11::bigint),
            (tests.uid('ta@example.com'), '00000000-0000-4000-8000-000000000003', tests.uid('alice@example.com')::text, repeat('ef', 32), 12::bigint) $$,
  'every removal leaves an audit row naming who removed what, whose it was, and its hash and size');
select is((select count(*) from public.audit_log where action = 'remove_submission' and subject->>'edition_id' = tests.edition('T-RM', '2026')::text), 3::bigint, 'and refused attempts leave none');

select * from finish();
rollback;
