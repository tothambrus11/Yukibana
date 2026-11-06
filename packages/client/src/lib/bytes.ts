/** Bytes helpers shared by the library and the CLI's commands. */
import { createHash } from 'node:crypto';

/** Returns the SHA-256 digest of `bytes` as 64 lowercase hex digits. `bytes` is not modified. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
