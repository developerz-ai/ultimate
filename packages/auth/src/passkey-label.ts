// Single responsibility: a passkey's label — the name its owner gives it ("Work laptop") so a list of
// several can be told apart and the right one removed. One reader for every label written
// (`passkeyLabel`), and `renamePasskey`, the owner-scoped rename — right after `register`, or later.

import type { PasskeyCredential } from './adapter';
import type { Auth } from './auth';
import { PASSKEY_LABEL_MAX, passkeyLabelInvalid, passkeyRenameUnsupported } from './passkey-errors';

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A surrogate half with no partner: memory would keep it, Postgres' UTF-8 `text` cannot. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Counted by code point and stopped at the first one past the limit: no array of a huge input. */
const longerThan = (text: string, max: number): boolean => {
  let length = 0;
  for (const _character of text) {
    length += 1;
    if (length > max) return true;
  }
  return false;
};

/**
 * The label as stored: trimmed, `null` for none. Judged AFTER the trim: blank, longer than
 * `PASSKEY_LABEL_MAX` characters, holding a control character (a newline in a list row, an escape in
 * a log line) or a lone surrogate (text no adapter can store as written) is refused.
 */
export function passkeyLabel(label: string | null | undefined): string | null {
  if (label === undefined || label === null) return null;
  const trimmed = label.trim();
  if (trimmed === '') throw passkeyLabelInvalid('blank');
  if (longerThan(trimmed, PASSKEY_LABEL_MAX)) throw passkeyLabelInvalid('too long');
  if (CONTROL.test(trimmed)) throw passkeyLabelInvalid('holding a control character');
  if (LONE_SURROGATE.test(trimmed)) throw passkeyLabelInvalid('not well-formed text');
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
