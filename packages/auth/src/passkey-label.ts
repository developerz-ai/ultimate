// Single responsibility: a passkey's label — the name its owner gives it ("Work laptop") so a list of
// several can be told apart and the right one removed. One reader for every label written
// (`passkeyLabel`, at `register` and here), and `renamePasskey`, the owner-scoped rename.

import type { PasskeyCredential } from './adapter';
import type { Auth } from './auth';
import { PASSKEY_LABEL_MAX, passkeyLabelInvalid, passkeyRenameUnsupported } from './passkey-errors';

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The label as stored: trimmed, `null` for none. Blank, longer than `PASSKEY_LABEL_MAX` characters
 * or holding a control character (a newline in a list row, an escape in a log line) is refused.
 */
export function passkeyLabel(label: string | null | undefined): string | null {
  if (label === undefined || label === null) return null;
  const trimmed = label.trim();
  if (trimmed === '') throw passkeyLabelInvalid('blank');
  if ([...trimmed].length > PASSKEY_LABEL_MAX) throw passkeyLabelInvalid('too long');
  if (CONTROL.test(trimmed)) throw passkeyLabelInvalid('holding a control character');
  return trimmed;
}

/**
 * Renames one of `userId`'s passkeys; `label: null` clears it. Answers the updated credential, or
 * `null` when no passkey of that user has the id — another user's included, exactly as
 * `deletePasskey` answers `false` for it. The app wraps it in its own action, as it wraps
 * `passkeyLogin`'s ceremonies, with the signed-in user's id.
 */
export async function renamePasskey(
  auth: Auth,
  input: { readonly userId: string; readonly id: string; readonly label: string | null },
): Promise<PasskeyCredential | null> {
  const rename = auth.adapter.renamePasskey;
  if (rename === undefined) throw passkeyRenameUnsupported(auth.adapter.name);
  return await rename.call(auth.adapter, input.userId, input.id, passkeyLabel(input.label));
}
