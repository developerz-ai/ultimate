// Single responsibility: what may appear inside an SMTP `MAIL FROM:<>` or `RCPT TO:<>`. One gate
// for the envelope, exactly as `mime.ts`'s `header()` is the one gate for the message — two wire
// formats, one check each, at the module that owns the format. Refuses; never rewrites.

import { addressInvalid, type EnvelopeAddressField } from './errors';

/**
 * Every character that can restructure the command line: C0 controls (CR and LF above all), DEL,
 * the C1 range, and the angle brackets that delimit the address — a `>` closes the bracket early
 * and turns whatever follows into ESMTP parameters.
 *
 * A space is deliberately NOT refused: RFC 5321 allows one inside a quoted local-part, and with
 * the brackets already refused it can only produce an address the server itself rejects, never a
 * second command. Non-ASCII is not refused either — whether a server takes a UTF-8 mailbox is
 * SMTPUTF8's question and the server's answer, not a decision this check may make on its behalf.
 */
function isUnsafe(address: string): boolean {
  for (let index = 0; index < address.length; index += 1) {
    const code = address.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x3c || code === 0x3e) return true; // '<' and '>'
  }
  return false;
}

/** Throws `X_MAIL_ADDRESS_INVALID` before a single byte of the envelope is written. */
export function assertEnvelopeAddress(field: EnvelopeAddressField, address: string): void {
  if (isUnsafe(address)) throw addressInvalid(field);
}
