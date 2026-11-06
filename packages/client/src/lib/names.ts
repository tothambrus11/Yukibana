/** Folder names for people, for `yukibana download`.
 *
 *  A teacher downloads every student's submission into one folder, one
 *  subfolder per student, named after the student so the folder reads like
 *  the roster. A name is whatever GitHub had as a display name, so it can be
 *  anything: a slash, a colon, a name Windows reserves, two students called
 *  the same. The rules here make it a name every common filesystem accepts
 *  and that no two students share, ignoring case (macOS and Windows do).
 */

export interface Person {
  readonly userId: string;
  readonly fullName: string | null;
  readonly githubLogin: string | null;
  readonly email: string | null;
}

/** Longest name in UTF-8 bytes. Filesystems allow 255; a path still has to
 *  fit under Windows' 260 characters with the rest of it. */
const MAX_BYTES = 80;

/** Device names Windows will not create a file or folder as, with or
 *  without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** `text` as one path segment that is safe everywhere: no separators, no
 *  control characters, none of `<>:"|?*`, no leading dot (which would hide
 *  it), no trailing dot or space (which Windows drops), not a reserved
 *  device name, not empty, and at most 80 bytes of UTF-8. Letters of every
 *  script are kept: "Zoë Ångström" stays that. */
export function safeSegment(text: string): string {
  // Whitespace first, so a tab or a line break becomes a space, not a `_`.
  let s = Array.from(text.normalize('NFC').replace(/\s+/g, ' '), ch => (unsafe(ch) ? '_' : ch))
    .join('')
    .trim()
    .replace(/^\.+/, dots => '_'.repeat(dots.length))
    .replace(/[. ]+$/, '');
  if (s === '') s = '_';
  if (RESERVED.test(s)) s = `_${s}`;
  return truncate(s, MAX_BYTES);
}

/** A control character, or one of the characters some filesystem refuses. */
function unsafe(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || '<>:"/\\|?*'.includes(ch);
}

function truncate(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (encoder.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out.replace(/[. ]+$/, '') || '_';
}

/** What a person is called, before it is made safe: their name, else their
 *  GitHub login, else the part of their address before the @, else their
 *  id. */
export function displayName(p: Person): string {
  const name = p.fullName?.trim();
  if (name) return name;
  if (p.githubLogin) return p.githubLogin;
  const local = p.email?.split('@')[0];
  if (local) return local;
  return p.userId;
}

/** A folder name for each person, by user id. Names that would collide,
 *  ignoring case, all get their GitHub login (or the start of their id)
 *  added in brackets, so neither student of a pair is the one with the
 *  plain name by accident of ordering. */
export function folderNames(people: readonly Person[]): Map<string, string> {
  const base = new Map(people.map(p => [p.userId, safeSegment(displayName(p))] as const));
  const out = new Map<string, string>();
  const count = new Map<string, number>();
  for (const name of base.values()) count.set(name.toLowerCase(), (count.get(name.toLowerCase()) ?? 0) + 1);
  for (const p of people) {
    const name = base.get(p.userId) ?? '_';
    if ((count.get(name.toLowerCase()) ?? 0) === 1) {
      out.set(p.userId, name);
      continue;
    }
    const tag = p.githubLogin && safeSegment(p.githubLogin).toLowerCase() !== name.toLowerCase() ? p.githubLogin : p.userId.slice(0, 8);
    out.set(p.userId, safeSegment(`${truncate(name, MAX_BYTES - 50)} (${tag})`));
  }
  // A login can repeat a name another student has as theirs; the id cannot.
  const seen = new Set<string>();
  for (const p of people) {
    const name = out.get(p.userId) ?? '_';
    if (seen.has(name.toLowerCase())) out.set(p.userId, safeSegment(`${truncate(name, MAX_BYTES - 12)} (${p.userId.slice(0, 8)})`));
    seen.add((out.get(p.userId) ?? '_').toLowerCase());
  }
  return out;
}

/** A submission's time as a folder name: sortable, and without the colons
 *  Windows refuses. `2026-10-07T14-03-05Z`. */
export function stampOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return safeSegment(iso);
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}
