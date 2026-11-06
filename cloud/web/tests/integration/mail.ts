/** The local stack's mail catcher, read the way a person reads their mail:
 *  for the code in it. Shared by the suites that log in by code. */
import { mailUrl } from './env.js';

type Found = { messages: { ID: string; Created: string }[] };

/** The code in the newest mail to `addr` sent at or after `since`, from the
 *  local mail catcher. Auth sends asynchronously, so this waits a little. */
export async function codeMailedTo(addr: string, since: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const found = (await (await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${addr}"`)}`)).json()) as Found;
    const mail = found.messages.find(m => Date.parse(m.Created) >= since - 1000);
    if (mail !== undefined) {
      const { Text } = (await (await fetch(`${mailUrl}/api/v1/message/${mail.ID}`)).json()) as { Text: string };
      const code = Text.match(/\b(\d{6})\b/)?.[1];
      if (code === undefined) throw new Error(`the mail to ${addr} has no code in it: ${Text}`);
      return code;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`no mail reached ${addr} at ${mailUrl}: is [local_smtp] enabled in cloud/db/supabase/config.toml?`);
}
