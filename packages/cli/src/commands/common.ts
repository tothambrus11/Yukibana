/** What every command shares: its options, how it fails, where the registry
 *  is, who is asking, and how a list is printed. */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, fileStore, parseConfig, type SessionStore, tokenProvider, YukibanaClient } from '@yukibana/client';

/** The options, as `parseArgs` reads them for every command. */
export interface Options {
  readonly out?: string | undefined;
  readonly folder?: string | undefined;
  readonly label?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly project?: string | undefined;
  readonly edition?: string | undefined;
  readonly 'student-submissions'?: readonly string[] | undefined;
  /** The old name of `--student-submissions`, still read so scripts keep
   *  working; it warns. */
  readonly student?: readonly string[] | undefined;
  readonly submission?: readonly string[] | undefined;
  readonly release?: string | undefined;
  readonly role?: string | undefined;
  readonly teacher?: string | undefined;
  readonly 'all-versions'?: boolean | undefined;
  readonly latest?: boolean | undefined;
  readonly assemble?: boolean | undefined;
  readonly archive?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly yes?: boolean | undefined;
}

export interface Invocation {
  readonly options: Options;
  /** The positionals after the command. */
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Where the session lives; a test passes a memory store. */
  readonly store: SessionStore;
}

/** A command that cannot go on, with every reason. `index.ts` prints them
 *  and exits 1; nothing else in the commands exits. */
export class Failure extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join('\n'));
  }
}

export const fail = (...lines: string[]): never => {
  throw new Failure(lines);
};

export function defaultStore(env: NodeJS.ProcessEnv): SessionStore {
  return fileStore(env['YUKIBANA_CONFIG_DIR'] === undefined ? undefined : join(env['YUKIBANA_CONFIG_DIR'], 'session.json'));
}

/** The registry: `--url`, else `YUKIBANA_URL`, else the one logged in to. */
export async function registryUrl(inv: Invocation): Promise<string> {
  const url = inv.options.url ?? inv.env['YUKIBANA_URL'] ?? (await inv.store.load())?.url;
  if (url === undefined || url === '') fail('which registry? give --url, set YUKIBANA_URL, or log in first');
  return url as string;
}

/** A client as the logged-in person. `YUKIBANA_ACCESS_TOKEN` stands in for a
 *  login where there is no browser, for a token got some other way. */
export async function clientFor(inv: Invocation): Promise<YukibanaClient> {
  return new YukibanaClient({ url: await registryUrl(inv), accessToken: accessTokenFor(inv) });
}

/** The person's access token: `YUKIBANA_ACCESS_TOKEN` when set, else the
 *  stored session, refreshed as needed. */
export function accessTokenFor(inv: Invocation): () => Promise<string> {
  const fixed = inv.env['YUKIBANA_ACCESS_TOKEN'];
  return fixed !== undefined && fixed !== '' ? async () => fixed : tokenProvider(inv.store);
}

/** The project a command is about: the first positional, else `--project`,
 *  else `YUKIBANA_PROJECT`, else the `projectId` in `dir`'s yukibana.json. */
export async function projectOf(inv: Invocation, positional: string | undefined, dir = '.'): Promise<string> {
  const given = positional ?? inv.options.project ?? inv.env['YUKIBANA_PROJECT'];
  if (given !== undefined && given !== '') return given;
  try {
    const parsed = parseConfig(await readFile(join(resolve(dir), CONFIG_FILE), 'utf8'));
    if (parsed.ok && parsed.config.projectId !== null) return parsed.config.projectId;
  } catch {
    // no file: fall through to the sentence below
  }
  return fail(`which project? give its id, or run this in a folder whose ${CONFIG_FILE} names one`);
}

/** Whose submissions `--student-submissions` asks for: names, logins,
 *  addresses or user ids, as `select` matches them. `--student`, its old
 *  name, still counts, with a warning: it read like a switch for "students
 *  only" rather than a filter by person. */
export function studentsOf(inv: Invocation): readonly string[] {
  const old = inv.options.student ?? [];
  if (old.length > 0) console.error('warning: --student is now --student-submissions; the old name will go');
  return [...(inv.options['student-submissions'] ?? []), ...old];
}

/** Prints rows as aligned columns, or as JSON with `--json` (the whole
 *  objects, for scripts). */
export function print<T>(inv: Invocation, rows: readonly T[], columns: Record<string, (row: T) => string>): void {
  if (inv.options.json === true) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const heads = Object.keys(columns);
  const cells = rows.map(r => heads.map(h => (columns[h] ?? (() => ''))(r)));
  const widths = heads.map((h, i) => Math.max(h.length, ...cells.map(c => (c[i] ?? '').length)));
  const line = (c: readonly string[]): string =>
    c
      .map((s, i) => s.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  console.log(line(heads));
  for (const c of cells) console.log(line(c));
}

/** A time for a person to read, in their zone: `2026-10-07 16:03`. */
export function when(iso: string | null): string {
  if (iso === null) return '-';
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A size for a person to read. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
