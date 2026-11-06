/** The terminal's half of a browser login: how `yukibana login` opens the
 *  sign-in address and what the browser shows when it comes back. The
 *  library leaves both to its host; these are the CLI's choices, and are
 *  not exported. */

import { spawn } from 'node:child_process';
import { type CallbackOutcome, loginCode } from '@yukibana/client';

/** Prints the address, in case no browser opens, and opens it in the
 *  system browser, best effort. */
export function openInBrowser(url: URL): void {
  console.error(`Opening your browser to log in. If it does not open, visit:\n\n  ${url.toString()}\n`);
  const code = loginCode(url);
  if (code !== null) console.error(`The page should show the code ${code}.\n`);
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url.toString()]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.toString().replace(/&/g, '^&')]]
        : ['xdg-open', [url.toString()]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address was printed; that is the fallback.
  }
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The page the browser lands on: tells the person to go back to the
 *  terminal, or why the login failed. */
export function callbackPage(outcome: CallbackOutcome): string {
  const [title, text] = outcome.ok ? ['Logged in', 'You can close this tab and return to the terminal.'] : ['Not logged in', escapeHtml(outcome.reason)];
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${text}</p></body>`;
}
