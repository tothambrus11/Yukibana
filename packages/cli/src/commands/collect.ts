/** A teacher's commands for what students sent: download it, one folder per
 *  student, and assemble it with the teacher's project. */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assemble,
  behind,
  chooseReleases,
  CONFIG_FILE,
  type Entry,
  folderNames,
  isEmptyDir,
  nameOf,
  parseConfig,
  readArchive,
  readTree,
  type Release,
  sha256Hex,
  stampOf,
  type Submission,
  submissionRoot,
  tampered,
  type Tampering,
  type Wanted,
  wantedRelease,
  writeEntries,
} from '@yukibana/client';
import { select } from './browse.js';
import { clientFor, fail, projectOf, studentsOf, type Invocation } from './common.js';
import { save } from './work.js';

/** What `download` writes beside the folders, so a grading script knows
 *  which folder is whose and what it found. */
interface Downloaded {
  readonly folder: string;
  readonly submissionId: string;
  readonly submittedAt: string;
  /** After the deadline, as the deadline was when this was downloaded. */
  readonly late: boolean;
  readonly sha256: string;
  readonly author: Submission['author'];
  /** The release the student started from, when known; what `tampering`
   *  was measured against. */
  readonly baseReleaseId: string | null;
  /** The release whose read-only and hidden files the folder holds; null
   *  without `--assemble`. */
  readonly assembledWith: string | null;
  readonly tampering: Tampering | null;
  /** Of `tampering`, what the release assembled with does not protect, so
   *  the student's version stayed; and the student's files that release
   *  replaced though the one they started from did not protect them. Both
   *  empty when the two releases are one. */
  readonly unrestored: readonly string[];
  readonly overridden: readonly string[];
}

/** `download <project> [--out dir]`: by default every student's newest
 *  submission, unpacked into `dir/<student name>/`. `--all-versions` takes
 *  every submission into `dir/<student name>/<time>/`, and so does naming
 *  submissions with `--submission`. `--student-submissions` narrows to some
 *  students (by name, GitHub login, address or id). `--assemble` overlays a
 *  release's read-only and hidden files and says what the student had
 *  changed of the release they started from; `--archive` keeps each
 *  `.tar.gz` as sent instead of unpacking. A student sees only their own
 *  submissions, so the same command is how a student gets back what they
 *  sent.
 *
 *  Which release `--assemble` uses: by default each submission's own base
 *  (the newest when that is unknown); `--release newest` the newest for
 *  everyone, so a fixed hidden test reaches every submission; `--release
 *  <id>` that one, which must be a release of this project. What the
 *  student changed is measured against their base whichever is used.
 *
 *  For staff, every submission not based on the newest release is a
 *  warning, with or without `--assemble`: started from an older release, or
 *  saying none. */
export async function download(inv: Invocation): Promise<void> {
  const id = await projectOf(inv, inv.args[0]);
  const o = inv.options;
  if (o.assemble === true && o.archive === true) fail('--assemble unpacks; --archive keeps the archive. Choose one.');
  if (o.release !== undefined && o.assemble !== true) fail('--release says which release to assemble with; it needs --assemble');
  const ids = o.submission ?? [];
  const versions = o['all-versions'] === true || ids.length > 0;
  const client = await clientFor(inv);
  const chosen = select(await client.submissions(id, { latest: !versions }), studentsOf(inv), ids);
  if (chosen.length === 0) {
    console.log('no submissions to download');
    return;
  }

  // The project's own releases are the only ones an assembly will use: an
  // id from anywhere else (a flag, a student's file) is checked against
  // this list, never fetched on its word. Fetched without --assemble too,
  // to say which submissions are behind the newest; a student's is empty.
  const releases: readonly Release[] = await client.releases(id);
  let wanted: Wanted = 'own';
  if (o.assemble === true) {
    const w = wantedRelease(releases, o.release);
    if (!w.ok) return fail(w.problem);
    wanted = w.wanted;
    const [newest] = releases;
    if (wanted === 'own') console.log(`assembling each submission with the release it started from (the newest, ${newest === undefined ? '' : nameOf(newest)}, when unknown)`);
    else {
      const named = wanted === 'newest' ? newest?.releaseId : wanted.releaseId;
      const r = releases.find(x => x.releaseId === named);
      console.log(`assembling with release ${r === undefined ? '' : nameOf(r)}`);
    }
  }
  const teachers = new Map<string, Promise<Entry[]>>();
  const teacherOf = (r: Release): Promise<Entry[]> => {
    let got = teachers.get(r.releaseId);
    if (got === undefined) {
      got = client
        .downloadRelease(r.releaseId, 'teacher')
        .then(readArchive)
        .catch((e: unknown) => {
          throw new Error(`the teacher archive of release ${r.releaseId} could not be read (${e instanceof Error ? e.message : String(e)})`);
        });
      teachers.set(r.releaseId, got);
    }
    return got;
  };
  const bases = { same: 0, older: 0, unknown: 0 };

  const out = resolve(o.out ?? `submissions-${id.slice(0, 8)}`);
  const authors = [...new Map(chosen.map(s => [s.author.userId, s.author] as const)).values()];
  const folders = folderNames(authors);
  const versionFolders = versions ? versionNames(chosen) : new Map<string, string>();
  const done: Downloaded[] = [];
  const problems: string[] = [];
  for (const s of chosen) {
    const name = folders.get(s.author.userId) ?? s.author.userId;
    const folder = versions ? join(name, versionFolders.get(s.submissionId) ?? s.submissionId) : name;
    try {
      const target = join(out, o.archive === true ? `${folder}.tar.gz` : folder);
      if (!(await vacant(target, o.force === true))) {
        problems.push(`${target} already exists; --force replaces it`);
        continue;
      }
      const archive = await client.downloadSubmission(s.submissionId);
      if (sha256Hex(archive) !== s.sha256) {
        problems.push(`${folder}: the download does not match the recorded sha256; not written`);
        continue;
      }
      let tampering: Tampering | null = null;
      let base: string | null = s.baseReleaseId;
      let assembledWith: string | null = null;
      let started = '';
      let unrestored: readonly string[] = [];
      let overridden: readonly string[] = [];
      if (o.archive === true) {
        await save(target, archive);
      } else {
        let entries = submissionRoot(await readArchive(archive));
        if (o.assemble === true) {
          const choice = chooseReleases(releases, wanted, s.baseReleaseId, claimedRelease(entries));
          for (const n of choice.notes) console.error(`warning: ${folder}: ${n}`);
          const grade = choice.grade;
          const teacher = await teacherOf(grade);
          let baseTeacher = teacher;
          if (choice.base !== null && choice.base !== grade) {
            try {
              baseTeacher = await teacherOf(choice.base);
            } catch (e) {
              console.error(`warning: ${folder}: ${e instanceof Error ? e.message : String(e)}; what the student changed is measured against ${nameOf(grade)} instead`);
            }
          }
          const made = assemble(entries, teacher, baseTeacher);
          if (!made.ok) {
            problems.push(`${folder}: ${made.problem}`);
            continue;
          }
          entries = [...made.assembly.entries];
          tampering = made.assembly.tampering;
          unrestored = made.assembly.unrestored;
          overridden = made.assembly.overridden;
          base = choice.base?.releaseId ?? null;
          assembledWith = grade.releaseId;
          if (choice.base === null) bases.unknown++;
          else if (choice.base === releases[0]) bases.same++;
          else bases.older++;
          if (choice.base === null) started = '  (started from an unknown release)';
          else if (choice.base !== grade) started = `  (started from ${nameOf(choice.base)})`;
          for (const r of made.assembly.refused) console.error(`warning: ${folder}: dropped ${r}, a symlink out of the project`);
        }
        for (const r of await writeEntries(target, entries)) console.error(`warning: ${folder}: not unpacked: ${r}`);
      }
      done.push({
        folder,
        submissionId: s.submissionId,
        submittedAt: s.submittedAt,
        late: s.late,
        sha256: s.sha256,
        author: s.author,
        baseReleaseId: base,
        assembledWith,
        tampering,
        unrestored,
        overridden,
      });
      console.log(`${folder}${s.late ? '  (late)' : ''}${started}${tampering !== null && tampered(tampering) ? `  ! ${describe(tampering, unrestored)}` : ''}`);
      const lag = behind(releases, base);
      if (lag !== null) console.error(`warning: ${folder}: ${lag}`);
      if (overridden.length > 0) console.log(`  ${folder}: replaced by the release assembled with, which protects them: ${overridden.join(', ')}`);
    } catch (e) {
      problems.push(`${folder}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Every submission may have failed, and then nothing made the folder; the
  // problems below are the answer, not an ENOENT from writing the manifest.
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'yukibana-download.json'), JSON.stringify({ projectId: id, downloadedAt: new Date().toISOString(), submissions: done }, null, 2) + '\n');
  console.log(`${done.length} of ${chosen.length} into ${out}`);
  if (o.assemble === true) {
    const [newest] = releases;
    console.log(
      `started from the newest release${newest === undefined ? '' : ` (${nameOf(newest)})`}: ${bases.same}; from an older one: ${bases.older}; unknown: ${bases.unknown}`,
    );
  }
  if (problems.length > 0) fail(...problems);
}

/** `assemble <submission> --teacher <archive> --out <dir>`: the same as
 *  `download --assemble`, from files already here. Each of the two may be
 *  an archive or a folder. */
export async function assembleCommand(inv: Invocation): Promise<void> {
  const from = inv.args[0] ?? fail('usage: yukibana assemble <submission.tar.gz|dir> --teacher <teacher.tar.gz|dir> --out <dir>');
  const teacherPath = inv.options.teacher ?? fail('--teacher names the teacher archive (or the course repository)');
  const out = resolve(inv.options.out ?? fail('--out names the folder to write'));
  if (!(await vacant(out, inv.options.force === true))) fail(`${out} already exists; --force replaces it`);
  const submission = submissionRoot(await entriesOf(from));
  // A teacher archive unpacks into a folder; a repository read from disk is
  // given one, so both look the same to the assembly.
  let teacher: Entry[];
  if ((await stat(teacherPath)).isDirectory()) {
    teacher = [];
    for (const e of await readTree(teacherPath)) teacher.push({ ...e, path: `project/${e.path}` });
  } else {
    teacher = await readArchive(new Uint8Array(await readFile(teacherPath)));
  }
  const made = assemble(submission, teacher);
  if (!made.ok) return fail(made.problem);
  for (const r of await writeEntries(out, made.assembly.entries)) console.error(`warning: not unpacked: ${r}`);
  for (const r of made.assembly.refused) console.error(`warning: dropped ${r}, a symlink out of the project`);
  const t = made.assembly.tampering;
  console.log(`assembled into ${out}`);
  if (tampered(t)) {
    for (const p of t.modified) console.log(`modified: ${p}`);
    for (const p of t.deleted) console.log(`deleted:  ${p}`);
    for (const p of t.added) console.log(`added:    ${p}`);
    console.log("(each replaced by the teacher's version)");
  }
}

/** The release a submission's own yukibana.json says it started from, or
 *  null when it says none or the file is not there or not valid. */
function claimedRelease(entries: readonly Entry[]): string | null {
  const cfg = entries.find(e => e.path === CONFIG_FILE && e.type === 'file');
  if (cfg === undefined) return null;
  const parsed = parseConfig(new TextDecoder().decode(cfg.data));
  return parsed.ok ? parsed.config.releaseId : null;
}

async function entriesOf(path: string): Promise<Entry[]> {
  return (await stat(path)).isDirectory() ? readTree(path) : readArchive(new Uint8Array(await readFile(path)));
}

/** Whether `path` may be written: missing, empty, or `force` (then it is
 *  removed first). */
async function vacant(path: string, force: boolean): Promise<boolean> {
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) return true;
  if ((await stat(path)).isDirectory() && (await isEmptyDir(path))) return true;
  if (!force) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

/** A folder per version, named by its time. Two versions of one student in
 *  the same second (it happens: a double click) get the start of their id
 *  added, so neither overwrites the other. */
function versionNames(subs: readonly Submission[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Map<string, number>();
  const key = (s: Submission): string => `${s.author.userId}/${stampOf(s.submittedAt)}`;
  for (const s of subs) taken.set(key(s), (taken.get(key(s)) ?? 0) + 1);
  for (const s of subs) out.set(s.submissionId, (taken.get(key(s)) ?? 0) > 1 ? `${stampOf(s.submittedAt)} ${s.submissionId.slice(0, 8)}` : stampOf(s.submittedAt));
  return out;
}

function describe(t: Tampering, unrestored: readonly string[]): string {
  const parts: string[] = [];
  if (t.modified.length > 0) parts.push(`modified ${t.modified.join(', ')}`);
  if (t.deleted.length > 0) parts.push(`deleted ${t.deleted.join(', ')}`);
  if (t.added.length > 0) parts.push(`added ${t.added.join(', ')}`);
  const all = t.modified.length + t.deleted.length + t.added.length;
  if (unrestored.length === 0) return `${parts.join('; ')} (replaced from the release)`;
  const kept = `the release assembled with does not protect ${unrestored.join(', ')}, so the student's version stays`;
  return `${parts.join('; ')} (${unrestored.length === all ? kept : `replaced from the release, except that ${kept}`})`;
}
