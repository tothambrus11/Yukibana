/** Reading the registry as yourself, and the roster writes an owner has. */

import { behind, type EditionRole, type Project, type Submission } from '@yukibana/client';
import { bytes, clientFor, fail, print, projectOf, studentsOf, when, type Invocation } from './common.js';

export async function editions(inv: Invocation): Promise<void> {
  const rows = await (await clientFor(inv)).editions();
  print(inv, rows, {
    edition: e => e.editionId,
    course: e => e.courseCode,
    label: e => e.label,
    role: e => e.role,
    state: e => (e.archived ? 'archived' : 'active'),
  });
}

export async function members(inv: Invocation): Promise<void> {
  const edition = inv.args[0] ?? inv.options.edition ?? fail('which edition? give its id (see `yukibana editions`)');
  const rows = await (await clientFor(inv)).members(edition);
  print(inv, rows, {
    email: m => m.email,
    role: m => m.role,
    name: m => m.fullName ?? '',
    github: m => m.githubLogin ?? '',
    linked: m => (m.userId === null ? 'not yet' : 'yes'),
  });
}

const ROLES: readonly EditionRole[] = ['student', 'assistant', 'owner'];

/** `enrol <edition> <email>...` and `unenrol <edition> <email>...`. Every
 *  address is tried; the ones that failed are named at the end. */
export async function roster(command: 'enrol' | 'unenrol', inv: Invocation): Promise<void> {
  const [edition, ...emails] = inv.args;
  if (edition === undefined || emails.length === 0) fail(`usage: yukibana ${command} <edition> <email>...`);
  const role = (inv.options.role ?? 'student') as EditionRole;
  if (!ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(', ')}`);
  const client = await clientFor(inv);
  const problems: string[] = [];
  for (const email of emails) {
    try {
      if (command === 'enrol') await client.enrol(edition as string, email, role);
      else await client.unenrol(edition as string, email);
      console.log(command === 'enrol' ? `enrolled ${email} as ${role}` : `unenrolled ${email}`);
    } catch (e) {
      problems.push(`${email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (problems.length > 0) fail(...problems);
}

/** Where a project stands for the person asking, in a word: `draft`,
 *  `scheduled`, `open`, `late` (past the deadline, still accepting) or
 *  `closed`. */
export function stateOf(p: Project, now = Date.now()): string {
  if (p.availableAfter === null) return 'draft';
  if (Date.parse(p.availableAfter) > now) return 'scheduled';
  if (p.closesAt !== null && Date.parse(p.closesAt) <= now) return 'closed';
  if (p.role === 'student' && !p.canSubmit) return 'closed';
  return p.late ? 'late' : 'open';
}

export async function projects(inv: Invocation): Promise<void> {
  let rows = await (await clientFor(inv)).projects(inv.options.edition);
  if (inv.options.open === true) rows = rows.filter(p => stateOf(p) === 'open' || stateOf(p) === 'late');
  print(inv, rows, {
    project: p => p.projectId,
    course: p => `${p.courseCode} ${p.editionLabel}`,
    title: p => p.title,
    state: p => stateOf(p),
    deadline: p => when(p.deadline),
    closes: p => when(p.closesAt),
    starter: p => (p.starterReady ? 'yes' : 'no'),
    mine: p => (p.role === 'student' ? `${p.mySubmissions}${p.myLastSubmittedAt === null ? '' : `, last ${when(p.myLastSubmittedAt)}`}` : p.role),
  });
}

export async function project(inv: Invocation): Promise<void> {
  const id = await projectOf(inv, inv.args[0]);
  const p = await (await clientFor(inv)).project(id);
  if (inv.options.json === true) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  console.log(`${p.title} (${p.slug}, ${p.kind}) in ${p.courseCode} ${p.editionLabel}`);
  console.log(
    `you are ${p.role}; ${stateOf(p)}; available after ${when(p.availableAfter)}; deadline ${when(p.deadline)}; closes ${p.closesAt === null ? 'never' : when(p.closesAt)}`,
  );
  console.log(`starter: ${p.starterReady ? 'available' : 'not released yet'}`);
  if (p.role === 'student')
    console.log(`your submissions: ${p.mySubmissions}${p.myLastSubmittedAt === null ? '' : `, last at ${when(p.myLastSubmittedAt)}`}${p.canSubmit ? '; you may submit now' : ''}`);
}

export async function releases(inv: Invocation): Promise<void> {
  const id = await projectOf(inv, inv.args[0]);
  const rows = await (await clientFor(inv)).releases(id);
  print(inv, rows, {
    release: r => r.releaseId,
    uploaded: r => when(r.uploadedAt),
    label: r => r.label,
    commit: r => r.commit?.slice(0, 12) ?? '',
    by: r => `${r.uploadedBy ?? '?'}${r.viaToken ? ' (token)' : ''}`,
    starter: r => bytes(r.starterSize),
    teacher: r => bytes(r.teacherSize),
  });
}

/** Whether `selector` names this submission's author: their user id, GitHub
 *  login, enrolled address, or full name, ignoring case. */
export function names(selector: string, s: Submission): boolean {
  const want = selector.trim().toLowerCase().replace(/^@/, '');
  const a = s.author;
  return [a.userId, a.githubLogin, a.email, a.fullName].some(v => v !== null && v.toLowerCase() === want);
}

/** The submissions `--student-submissions` and `--submission` select, or every one
 *  given. A selector that matches nothing is a failure: a typo in a name
 *  must not read as "that student did not submit". */
export function select(all: readonly Submission[], students: readonly string[], ids: readonly string[]): Submission[] {
  const problems: string[] = [];
  for (const s of students) if (!all.some(x => names(s, x))) problems.push(`no submission by "${s}" here`);
  for (const id of ids) if (!all.some(x => x.submissionId === id.toLowerCase())) problems.push(`no submission ${id} here`);
  if (problems.length > 0) fail(...problems);
  return all.filter(x => (students.length === 0 || students.some(s => names(s, x))) && (ids.length === 0 || ids.includes(x.submissionId)));
}

/** `submissions`: the list, then a warning on stderr for each one not based
 *  on the newest release (staff only: a student's release list is empty, so
 *  they get none). Stderr, so `--json` stays parseable. */
export async function submissions(inv: Invocation): Promise<void> {
  const id = await projectOf(inv, inv.args[0]);
  const client = await clientFor(inv);
  const all = await client.submissions(id, { latest: inv.options.latest === true });
  const rows = select(all, studentsOf(inv), inv.options.submission ?? []);
  const published = await client.releases(id);
  print(inv, rows, {
    submission: s => s.submissionId,
    submitted: s => when(s.submittedAt),
    student: s => s.author.fullName ?? s.author.githubLogin ?? s.author.email ?? s.author.userId,
    github: s => s.author.githubLogin ?? '',
    size: s => bytes(s.byteSize),
    latest: s => [s.latest ? 'latest' : '', s.late ? 'late' : ''].filter(Boolean).join(', '),
    'started from': s => s.baseReleaseId ?? '-',
  });
  for (const s of rows) {
    const lag = behind(published, s.baseReleaseId);
    const who = s.author.fullName ?? s.author.githubLogin ?? s.author.email ?? s.author.userId;
    if (lag !== null) console.error(`warning: ${who}, submission ${s.submissionId}: ${lag}`);
  }
}
