/** The small glob language `yukibana.json` uses for hidden paths.
 *
 *  Patterns are relative to the repository root and match whole path
 *  segments: `*` is anything within one segment, `**` is any number of
 *  segments, `?` is one character. A pattern that matches a directory matches
 *  everything under it, so `tests/hidden` and `tests/hidden/**` hide the same
 *  files. There is no negation and no brace expansion: the point of the file
 *  is to be read by a teacher in a hurry.
 *
 *  This is ours rather than a library's on purpose (October 2026): it is
 *  0.4 KB gzipped in a bundle. picomatch keeps these rules with five
 *  options (`dot`, `nobrace`, `noextglob`, `nonegate`, `literalBrackets`)
 *  but is 9 KB, because what the options turn off is still in its parser.
 *  zeptomatch (3.5 KB) and Node's `path.matchesGlob` cannot turn off braces,
 *  brackets or negation, and both skip dotfiles: `tests/*` would stop
 *  hiding `tests/.secret.rs`. fast-glob walks a filesystem, which this never
 *  does; the paths come from a tree or an archive in memory.
 */

/** The regular expression for one pattern, anchored to the whole path. */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  const p = pattern.replace(/^\.?\//, '').replace(/\/+$/, '');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        const slash = p[i + 2] === '/';
        out += slash ? '(?:[^/]+/)*' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c !== undefined) {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

/** A predicate over paths for a set of patterns. A path is matched when it,
 *  or any directory above it, matches any pattern. */
export function matcher(patterns: readonly string[]): (path: string) => boolean {
  const regexps = patterns.map(globToRegExp);
  return (path: string): boolean => {
    const clean = path.replace(/^\.?\//, '').replace(/\/+$/, '');
    const parts = clean.split('/');
    for (let n = parts.length; n >= 1; n--) {
      const candidate = parts.slice(0, n).join('/');
      if (regexps.some(r => r.test(candidate))) return true;
    }
    return false;
  };
}
