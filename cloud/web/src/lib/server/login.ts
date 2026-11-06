/** Logging in by a code mailed to the address.
 *
 *  Supabase Auth does all of it: these two calls are here so the login page
 *  and the integration suite run the same code, and so what a failure tells
 *  the person is decided once. Nothing here touches the database: the
 *  account, its profile and its enrolments follow from `auth.users`, through
 *  the trigger in the courses migration.
 */

import { trustId, type UserId } from '#lib/ids.ts';
import { report } from '#lib/report.ts';
import type { Supabase } from '#lib/server/session.ts';

/** The two calls this needs, so a test can pass a client of its own. */
export type CodeAuth = Pick<Supabase['auth'], 'signInWithOtp' | 'verifyOtp'>;

/** What the page shows. `message` is written for the person, not the log. */
export type Refused = { readonly ok: false; readonly status: number; readonly message: string };

/** Mails a code to `email`, creating the account if the address has none.
 *  Anyone may ask: an account with no enrolment sees nothing, and an
 *  address that already has an account (from GitHub) gets a code for that
 *  one. A new account is unconfirmed until its code is verified
 *  (`enable_confirmations` in cloud/db/supabase/config.toml), so asking for a code
 *  for someone else's address links nothing. `email` is from `addressOf`. */
export async function sendCode(auth: CodeAuth, email: string): Promise<{ readonly ok: true } | Refused> {
  const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error === null) return { ok: true };
  if (error.status === 429) return { ok: false, status: 429, message: 'Too many codes asked for just now. Wait a minute and try again.' };
  return { ok: false, status: 502, message: report('login', `could not send a code to ${email}: ${error.message}`) };
}

/** Turns the code into a session on `auth`'s client, which for the page is
 *  this request's cookies. A code works once. Wrong and expired are one
 *  answer: Auth does not tell them apart, and neither should a guesser. */
export async function verifyCode(auth: CodeAuth, email: string, code: string): Promise<{ readonly ok: true; readonly userId: UserId } | Refused> {
  const { data, error } = await auth.verifyOtp({ email, token: code, type: 'email' });
  if (error === null && data.user !== null) return { ok: true, userId: trustId<UserId>(data.user.id) };
  return { ok: false, status: 400, message: 'That code is wrong or has expired. Ask for a new one.' };
}
