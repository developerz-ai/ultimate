// Single responsibility: what may appear inside an SMTP `MAIL FROM:<>` or `RCPT TO:<>`. One gate
// for the envelope, exactly as `mime.ts`'s `header()` is the one gate for the message — two wire
// formats, one check each, at the module that owns the format. It refuses, and it normalises one
// thing only — the RFC 5322 display form down to the mailbox `RCPT TO:` can carry, always after
// the control-character check, never before it.

import { addressInvalid, type EnvelopeAddressField } from './errors';
import { addressSpec } from './mime';

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
    if (code === 0x3c || code === 0x3e) return true; // '<' and '>'
  }
  return hasControlCharacter(address);
}

/** C0 controls (CR and LF above all), DEL and the C1 range — everything that ends a command line. */
function hasControlCharacter(address: string): boolean {
  for (let index = 0; index < address.length; index += 1) {
    const code = address.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Throws `X_MAIL_ADDRESS_INVALID` before a single byte of the envelope is written. */
export function assertEnvelopeAddress(field: EnvelopeAddressField, address: string): void {
  if (isUnsafe(address)) throw addressInvalid(field);
}

/**
 * The addr-spec an envelope command may carry, from whatever form the caller wrote. `Jane Doe
 * <jane@x.test>` is the ordinary RFC 5322 display form — the `To:` header carries it verbatim and
 * the resend, memory and log drivers all accept it — but `RCPT TO:` takes a mailbox, so it is
 * stripped here and the gate above runs on what is left.
 *
 * The control-character half runs on the RAW value, BEFORE the strip, and the order is the whole
 * point: `ops@x.test\r\nRCPT TO:<attacker@evil.test>` strips down to a clean-looking mailbox that
 * every later check waves through, so a strip-then-check would have turned the injection into a
 * delivery to the attacker instead of a refusal.
 */
export function envelopeAddress(field: EnvelopeAddressField, address: string): string {
  if (hasControlCharacter(address)) throw addressInvalid(field);
  const spec = addressSpec(address);
  assertEnvelopeAddress(field, spec);
  return spec;
}
