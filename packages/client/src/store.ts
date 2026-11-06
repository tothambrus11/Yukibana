/** The terminal's session store: one file, readable by its owner only.
 *
 *  `$YUKIBANA_CONFIG_DIR/session.json`, or under `$XDG_CONFIG_HOME`, or
 *  `~/.config/yukibana/`. The file holds a refresh token, which is as good as
 *  the person's login until it is used or they log out, so it is written
 *  with mode 0600 into a directory with mode 0700, and replaced atomically
 *  so a crash mid-write cannot leave half a token.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session, SessionStore } from './session.js';

export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['YUKIBANA_CONFIG_DIR'] ?? join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'yukibana');
  return join(dir, 'session.json');
}

export function fileStore(path: string = defaultSessionPath()): SessionStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      const raw: unknown = JSON.parse(text);
      return isSession(raw) ? raw : null;
    },
    async save(session) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/** Whether a stored file is a session this version can use. Anything else
 *  is treated as no session, so a damaged file means "log in again", not a
 *  crash. */
function isSession(v: unknown): v is Session {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    ['url', 'supabaseUrl', 'publishableKey', 'accessToken', 'refreshToken'].every(k => typeof o[k] === 'string') &&
    typeof o['expiresAt'] === 'number' &&
    (o['email'] === null || typeof o['email'] === 'string') &&
    (o['clientId'] === undefined || typeof o['clientId'] === 'string')
  );
}
