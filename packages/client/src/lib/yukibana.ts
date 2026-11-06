/** The contract between a course repository and this service: `yukibana.json`
 *  at the project root. It is the file the student's IDE (our Theia fork)
 *  reads for which widgets it shows, which files open and which are
 *  read-only, and the file the builder reads for the build system, what a
 *  student must never receive and what a submission holds.
 *  `docs/cloud/yukibana.schema.json` is its schema and `docs/cloud/yukibana-json.md`
 *  the prose.
 *
 *  ```json
 *  {
 *    "version": 1,
 *    "kind": "scala-sbt",
 *    "openFiles": ["README.md", "src/main/scala/Main.scala"],
 *    "readOnly": ["src/test/**", "README.md", "yukibana.json"],
 *    "hidden": ["src/test/scala/hidden"],
 *    "submission": { "exclude": [".scala-build"] }
 *  }
 *  ```
 *
 *  One zod schema (`configSchema`) checks the whole file, the IDE's fields
 *  with the IDE's defaults included, and the IDE parses the file with it
 *  (`settingsSchema`, the part it reads), so the two cannot disagree about
 *  what a field means. It is the whole of `zod`, not `zod/mini`: the
 *  mini build saved a few dozen KB in bundles that are hundreds of MB,
 *  at the price of a terser API nobody else here writes.
 *  The starter's copy is the file as written, so a
 *  field this version does not know passes through untouched.
 */

import * as z from 'zod';
// The function form of .default(), which zod spells _default, since default is a keyword.
import { _default as withDefault } from 'zod';
import { matcher } from './glob.js';
import { expectation, fieldOf } from './issues.js';

/** The file's name, at the project root, in the repository and in every
 *  starter. */
export const CONFIG_FILE = 'yukibana.json';

export const KINDS = ['rust-cargo', 'scala-sbt'] as const;
export type Kind = (typeof KINDS)[number];

export interface SubmissionRules {
  /** When not null, only paths matching one of these are submitted. */
  readonly include: readonly string[] | null;
  /** Never submitted, on top of what is never submitted for any project
   *  (`NEVER_SUBMITTED`) and what the kind's build leaves (`buildOutput`). */
  readonly exclude: readonly string[];
  /** `true` iff what the project's `.gitignore` files ignore is not
   *  submitted either, as git would leave it out of a commit. */
  readonly respectGitignore: boolean;
  /** Where the IDE sends a submission: `cloud`, the registry, or `file`, an
   *  archive the student saves. The CLI always sends to the registry. */
  readonly target: string;
  /** What a packed submission is called on disk. Only a name: the bytes are
   *  always a gzipped tar, because that is what the registry accepts. */
  readonly filename: string;
  /** The largest submission this project expects, in bytes. The registry
   *  has its own cap above which this cannot go. */
  readonly maxBytes: number;
}

/** Which of the IDE's helpers a project has on. */
export interface Features {
  readonly codeSuggestions: boolean;
  /** Error and warning underlines in the editor. */
  readonly squiggles: boolean;
  readonly codeLenses: boolean;
  readonly ai: boolean;
}

/** Which of the IDE's views a project shows; each is shown unless set false. */
export interface Widgets {
  readonly files: boolean;
  readonly search: boolean;
  readonly vcs: boolean;
  readonly debug: boolean;
  readonly testing: boolean;
  readonly outline: boolean;
  readonly aiChat: boolean;
}

/** How the IDE lays out a project's window. */
export interface Layout {
  readonly widgets: Widgets;
  /** View containers by id, shown iff true; one not named is left as it is. */
  readonly containers: Readonly<Record<string, boolean>>;
  /** Views by id, shown iff true; one not named is left as it is. */
  readonly views: Readonly<Record<string, boolean>>;
}

/** What kind of telemetry should be sent. */
export interface Telemetry {
  /** Whether to send live stats about what the user is typing in the IDE. */
  readonly liveTypingStats: boolean;
}

/** What a student's folder is set up with: the fields the IDE reads, each
 *  with its default when the file leaves it out. */
export interface Settings {
  /** The file the IDE opens as the assignment, relative to the root. */
  readonly assignmentFile: string;
  readonly features: Features;
  readonly layout: Layout;
  /** Files the IDE opens when the project opens. */
  readonly openFiles: readonly string[];
  /** Paths a student receives and may not change. An assembly replaces what
   *  a submission holds under them with the teacher's version, and says so
   *  when the two differ. */
  readonly readOnly: readonly string[];
  readonly submission: SubmissionRules;
  readonly telemetry: Telemetry;
  /** The registry project this folder submits to. Only a starter's copy has
   *  one (`starterConfig` writes it); in a course repository it is null. */
  readonly projectId: string | null;
}

/** The whole file, as a course repository and a starter carry it. */
export interface Config extends Settings {
  readonly version: 1;
  readonly kind: Kind;
  /** Paths a student must never receive, as globs relative to the root. */
  readonly hidden: readonly string[];
  /** The release this folder's starter was, as `yukibana build` and
   *  `publish` wrote it before uploading, so it is the release row's own id.
   *  A submission sends it, and grading compares the student's read-only
   *  files with that release rather than the newest. Null in a course
   *  repository, in a starter from before releases carried ids, and in one
   *  built only to check. A student can edit it, so it is a claim: the
   *  registry keeps it only when it names a release of the same project. */
  readonly releaseId: string | null;
  /** The parsed file as written, so the starter's copy carries the IDE's
   *  fields exactly, including ones this version does not know. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The largest submission accepted when the file does not say. A source
 *  tree without build output is well under a megabyte; the cap is for the
 *  student who tars up `target/`. */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** What `submission.filename` is when the file does not say. */
export const DEFAULT_FILENAME = 'submission.tar.gz';

/** The IDE's own state. Everything the IDE is set up with is declared in
 *  this file and read by the Theia fork, so a `.theia` folder is only ever
 *  one person's leftovers: it is in no archive and no submission. */
export const IDE_STATE = '.theia';

/** What can never be in a starter: the history (which would contain the
 *  hidden tests' every version), the teacher's own CI, the IDE's state, and
 *  the config file itself, which is replaced by the copy `starterConfig`
 *  writes. */
export const ALWAYS_EXCLUDED: readonly string[] = ['.git', '.github', IDE_STATE, CONFIG_FILE];

/** What no submission carries, whatever the project says: a student's
 *  history is theirs and can be large, the IDE's state is not work, and
 *  what a package manager installed is not the student's either. */
export const NEVER_SUBMITTED: readonly string[] = ['.git', IDE_STATE, '**/node_modules'];

/** What each build system leaves lying around that no archive carries,
 *  starter, teacher or submission. A teacher builds from their working
 *  tree, not from git, so this is what keeps a local `target/` out of a
 *  release. Paths at the root only. */
const KIND_OUTPUT: Record<Kind, readonly string[]> = {
  'rust-cargo': ['target'],
  'scala-sbt': ['target', 'project/target', 'project/project', '.bsp', '.bloop', '.metals', '.scala-build', '.idea'],
};

export function buildOutput(kind: Kind): readonly string[] {
  return KIND_OUTPUT[kind];
}

/** Every pattern the starter drops for `config`, hidden paths last. */
export function excludes(config: Config): readonly string[] {
  return [...ALWAYS_EXCLUDED, ...KIND_OUTPUT[config.kind], ...config.hidden];
}

/** What a teacher assembly takes from the teacher's version rather than the
 *  student's: this file, which decides the rest and so is never the
 *  student's to say, everything read-only and everything hidden. */
export function protectedPaths(config: Config): readonly string[] {
  return [CONFIG_FILE, ...config.readOnly, ...config.hidden];
}

export type Parsed = { ok: true; config: Config; warnings: readonly string[] } | { ok: false; error: string };

/** `true` iff `s` is a uuid, in any case. Release ids are the database's
 *  uuids, so this is the whole check the CLI can make of one. */
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** The shape of a project id: a uuidv7, in any case, because the database
 *  makes every one with `app.uuidv7()`. */
const projectIdSchema = z.uuidv7('must be a project id, a uuidv7');

/** `true` iff `s` could be a project id. `build --project` checks it, so a
 *  starter never carries an id its own `yukibana.json` would refuse. */
export function isProjectId(s: string): boolean {
  return projectIdSchema.safeParse(s).success;
}

const bool = z.boolean();
const on = withDefault(bool, true);
const flags = z.record(z.string(), bool);
const paths = z.array(z.string());
/** A list of globs relative to the project root. */
const globs = paths.check(
  z.refine((list: string[]) => list.every(s => s !== ''), 'must be a list of paths'),
  z.refine((list: string[]) => !list.some(s => s.startsWith('/') || s.split('/').includes('..')), 'paths are relative to the project root'),
);

/** Returns `schema` described by `text` in the published JSON Schema. */
const about = <T extends z.ZodType>(schema: T, text: string): T => schema.check(z.describe(text));

/** The fields of `Settings`, as the file spells them, with their defaults. */
const settingsShape = {
  assignmentFile: about(withDefault(z.string(), 'ASSIGNMENT.md'), 'The file the IDE opens as the assignment, relative to the project root.'),
  features: about(
    z.prefault(
      z.object({
        codeSuggestions: about(on, 'Code completion in the editor.'),
        squiggles: about(on, 'Error and warning underlines in the editor.'),
        codeLenses: about(on, 'Inline actions in the editor.'),
        ai: about(on, "The IDE's AI features."),
      }),
      {},
    ),
    "Which of the IDE's helpers are on; each is on unless set false.",
  ),
  layout: about(
    z.prefault(
      z.object({
        widgets: about(
          z.prefault(z.object({ files: on, search: on, vcs: on, debug: on, testing: on, outline: on, aiChat: on }), {}),
          "Which of the IDE's views show; each shows unless set false.",
        ),
        containers: about(withDefault(flags, {}), 'View containers by id, shown if true and hidden if false; one not named is left as it is.'),
        views: about(withDefault(flags, {}), 'Views by id, shown if true and hidden if false; one not named is left as it is.'),
      }),
      {},
    ),
    "How the IDE lays out the project's window.",
  ),
  openFiles: about(withDefault(paths, []), 'Files the IDE opens when the project opens, relative to the project root.'),
  readOnly: about(
    withDefault(globs, []),
    "Globs of files the student receives but may not change. When a teacher assembles a submission, whatever the student sent under these paths is replaced by the teacher's version, and every change is reported.",
  ),
  submission: about(
    z.prefault(
      z.object({
        include: about(withDefault(z.nullable(globs), null), 'When present, only paths matching these globs are submitted, and yukibana.json always.'),
        exclude: about(withDefault(globs, []), "Globs never submitted, on top of the history, the IDE's state, node_modules and the kind's build output, which never are."),
        respectGitignore: about(
          withDefault(bool, true),
          "Whether what the project's .gitignore files ignore is left out of a submission too, as git would leave it out of a commit.",
        ),
        target: about(
          withDefault(z.string(), 'cloud'),
          'Where the IDE sends a submission: cloud, the registry, or file, an archive the student saves. The CLI always sends to the registry.',
        ),
        filename: about(
          withDefault(z.string().check(z.refine((name: string) => name !== '' && !/[/\\]/.test(name), 'must be a file name, without a directory')), DEFAULT_FILENAME),
          'What yukibana pack calls the archive it writes. The bytes are always a gzipped tar, whatever the name says.',
        ),
        maxBytes: about(
          withDefault(z.number().check(z.int(), z.positive()), DEFAULT_MAX_BYTES),
          'The largest submission this project expects, in bytes. The registry has its own cap above which this cannot go.',
        ),
      }),
      {},
    ),
    'What a submission from this folder holds, and where the IDE sends it.',
  ),
  telemetry: about(
    z.prefault(
      z.object({
        liveTypingStats: about(withDefault(bool, false), 'Whether to send live stats about what the user is typing in the IDE.'),
      }),
      {},
    ),
    'What kind of telemetry should be sent.',
  ),
  projectId: about(
    withDefault(z.nullable(projectIdSchema), null),
    "Written by yukibana build and publish into the starter's copy of this file: the registry project a submission from this folder goes to. A course repository leaves it out.",
  ),
};

/** What the IDE reads from the file: every field optional, so a folder whose
 *  file says nothing, or that has none, still opens with defaults. */
export const settingsSchema = z.object(settingsShape);

/** The whole file: `settingsSchema` plus what a release is built from. */
export const configSchema = z.object({
  $schema: about(z.optional(z.string()), 'The URL of this schema, for an editor to check the file with. The IDE and the CLI ignore it.'),
  version: about(z.literal(1), 'The shape of this file. Always 1; a future shape gets a new number.'),
  kind: about(z.enum(KINDS), 'The build system. Chooses the build output no archive carries and the manifest checks the build makes.'),
  hidden: about(
    withDefault(globs, []),
    "Globs of files the student never receives: removed from the starter, and from the starter's copy of this file. When a teacher assembles a submission they are put back from the teacher's version, like readOnly. A pattern naming a directory covers everything under it; * stays within a path segment, ** crosses segments, ? is one character.",
  ),
  releaseId: about(
    withDefault(z.nullable(z.string().check(z.refine(isUuid, 'must be a release id, a uuid'))), null),
    "Written by yukibana build and publish into the starter's copy of this file: the release this starter is, chosen before the upload so the release row has the same id. A submission sends it, so a teacher can tell which release it started from. A course repository leaves it out.",
  ),
  ...settingsShape,
});

/** Where the published JSON Schema of the file lives, as its `$id`: the
 *  registry serves it there, and a `yukibana.json` may name it as `$schema`. */
export const SCHEMA_URL = 'https://cloud.yukibana.dev/schema/yukibana.json';

/** Returns the JSON Schema of the file, generated from `configSchema`, as
 *  `docs/cloud/yukibana.schema.json` holds it and the registry serves it at
 *  `SCHEMA_URL`. A test fails when the committed file is not this. */
export function configJSONSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(configSchema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  return {
    $schema: generated['$schema'],
    $id: SCHEMA_URL,
    title: CONFIG_FILE,
    description:
      "A project's configuration: its build system, what the student's IDE shows, which files the student may not change, what the student never receives, and what a submission holds. Lives at the project root. docs/cloud/yukibana-json.md in ISC-HEI/Yukibana is the prose.",
    ...generated,
  };
}

/** The top-level fields this version knows. Anything else is passed through
 *  to the starter with a warning: the IDE may know a field the CLI does not,
 *  and a typo like "hiden" should not pass in silence. */
const KNOWN = new Set(Object.keys(configSchema.shape));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns every one of `issues` as a sentence naming its field, joined
 *  by "; ", because the teacher reads them and fixes the file. It once
 *  named only the first, so a file with three mistakes took three runs. */
function sentence(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return `${CONFIG_FILE} is not valid`;
  return issues
    .map(issue => {
      const field = fieldOf(issue.path);
      return field === '' ? `${CONFIG_FILE} ${expectation(issue)}` : `${CONFIG_FILE}: "${field}" ${expectation(issue)}`;
    })
    .join('; ');
}

/** Returns `text` as a JSON object, or why it is not one. */
function objectOf(text: string): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${CONFIG_FILE} is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  return isObject(raw) ? { ok: true, raw } : { ok: false, error: `${CONFIG_FILE} must be an object` };
}

/** Returns the file `text` checked, with its defaults, or why it is not
 *  valid, as a sentence naming the field. */
export function parseConfig(text: string): Parsed {
  const read = objectOf(text);
  if (!read.ok) return read;
  const parsed = configSchema.safeParse(read.raw);
  if (!parsed.success) return { ok: false, error: sentence(parsed.error.issues) };
  const warnings = Object.keys(read.raw)
    .filter(k => !KNOWN.has(k))
    .map(k => `${CONFIG_FILE}: unknown field "${k}" is passed through as it is`);
  const config: Config = { ...parsed.data, projectId: parsed.data.projectId?.toLowerCase() ?? null, releaseId: parsed.data.releaseId?.toLowerCase() ?? null, raw: read.raw };
  return { ok: true, config, warnings };
}

/** Returns what the IDE reads from `text`, a `yukibana.json`, or why it
 *  cannot. Unlike `parseConfig`, a file without `version` or `kind` is
 *  fine: the IDE opens any folder. */
export function parseSettings(text: string): { ok: true; settings: Settings } | { ok: false; error: string } {
  const read = objectOf(text);
  if (!read.ok) return read;
  const parsed = settingsSchema.safeParse(read.raw);
  return parsed.success ? { ok: true, settings: parsed.data } : { ok: false, error: sentence(parsed.error.issues) };
}

/** What the IDE is set up with in a folder without a `yukibana.json`. */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** The fields of the starter's copy: the file minus `hidden` (which would
 *  name what it hides) and minus any `projectId` or `releaseId` the
 *  repository had, which only a build may write. */
function studentFields(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...raw };
  delete copy['hidden'];
  delete copy['projectId'];
  delete copy['releaseId'];
  return copy;
}

/** The copy of the file a starter carries: the same file minus `hidden`
 *  plus the project id, so the IDE and `yukibana submit` know where a
 *  submission goes, and the release id, so a submission says which
 *  release it started from. An empty `projectId` (a build that was not told
 *  the project) leaves the field out: it once wrote `""`, which the parser
 *  rightly refuses, and a student could not submit from that folder at all.
 *  A null `releaseId` (a build that is only a check) leaves its field out
 *  likewise. */
export function starterConfig(config: Config, projectId: string, releaseId: string | null): string {
  const fields: Record<string, unknown> = studentFields(config.raw);
  if (projectId !== '') fields['projectId'] = projectId;
  if (releaseId !== null) fields['releaseId'] = releaseId;
  return JSON.stringify(fields, null, 2) + '\n';
}

/** Whether a student's copy of the file says what the starter's copy said,
 *  `projectId`, `releaseId` and formatting aside. The release id differs
 *  from one release to the next by design, so it is not a change the
 *  student made; whether it names the right release is the download's
 *  question, not this one. An assembly asks this to tell a
 *  student who changed their read-only list from one who did not; the copy
 *  is replaced by the teacher's either way. */
export function sameStudentConfig(teacher: Config, studentText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(studentText);
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  return canonical(studentFields(parsed)) === canonical(studentFields(teacher.raw));
}

/** JSON with object keys sorted, so two files that say the same thing in a
 *  different order compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .toSorted()
      .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Ways a repository can defeat the starter: a build manifest that names a
 *  hidden path. Deleting the file would then leave a manifest pointing at
 *  nothing, and the starter would not build. For now the rule is that hidden
 *  tests must be auto-discovered; rewriting manifests is the per-kind
 *  extension point this function will grow into. `read` returns a file's
 *  text by path, or undefined. */
export function manifestProblems(config: Config, read: (path: string) => string | undefined): string[] {
  const hidden = matcher(config.hidden);
  const problems: string[] = [];
  if (config.kind === 'rust-cargo') {
    const cargo = read('Cargo.toml');
    if (cargo === undefined) {
      problems.push('Cargo.toml is missing at the repository root');
      return problems;
    }
    for (const m of cargo.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
      const p = m[1] ?? '';
      if (hidden(p)) problems.push(`Cargo.toml names the hidden path "${p}"; hidden tests must be auto-discovered`);
    }
    const members = /\bmembers\s*=\s*\[([^\]]*)\]/.exec(cargo);
    if (members) {
      for (const m of (members[1] ?? '').matchAll(/"([^"]+)"/g)) {
        const p = m[1] ?? '';
        if (hidden(p)) problems.push(`Cargo.toml lists the hidden workspace member "${p}"`);
      }
    }
  } else {
    if (read('build.sbt') === undefined) problems.push('build.sbt is missing at the repository root');
  }
  return problems;
}
