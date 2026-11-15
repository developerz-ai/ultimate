// Single responsibility: the byte-level decodes an inbound part needs — a lossless binary string
// both ways, Content-Transfer-Encoding (base64, quoted-printable, identity), and a charset label
// to text. Each refusal is `X_MAIL_INBOUND_MALFORMED`; an unknown CHARSET is not one (UTF-8 reads it).

import { inboundMalformed } from './mime-parse-errors';

const UTF16 = new TextDecoder('utf-16le');

/**
 * Bytes → one char per byte (U+0000–U+00FF), natively: each byte widened to a UTF-16 code unit
 * and decoded in one call. Never `TextDecoder('latin1')` (that is windows-1252), and never a
 * `fromCharCode` loop — that took half a second per MiB.
 */
export function binaryOf(bytes: Uint8Array): string {
  return UTF16.decode(new Uint16Array(bytes));
}

/** The inverse of `binaryOf`: every char is below 256 by construction. */
export function bytesOf(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at) & 0xff;
  return out;
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

function base64(binary: string): Uint8Array {
  const compact = binary.replace(/[\t\n\r ]/g, '');
  // A bad length is padded (clients truncate the final `=`), a bad alphabet is refused.
  if (!BASE64_BODY.test(compact) || compact.length % 4 === 1) throw inboundMalformed('base64');
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
  try {
    return bytesOf(atob(padded));
  } catch {
    throw inboundMalformed('base64');
  }
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

const isBlank = (code: number): boolean => code === 0x20 || code === 0x09;

/**
 * Transport padding (spaces/tabs before a line break) dropped, in ONE pass. Never a regex like
 * `/[\t ]+(?=\r?\n)/g`: with no newline after a long run it retries from every space, which is
 * quadratic — 100 KB of spaces held the event loop for 50 s.
 */
function trimLineEnds(binary: string): string {
  const lines = binary.split('\n');
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? '';
    const cr = line.endsWith('\r') ? 1 : 0;
    let end = line.length - cr;
    while (end > 0 && isBlank(line.charCodeAt(end - 1))) end -= 1;
    lines[index] = line.slice(0, end) + (cr === 1 ? '\r' : '');
  }
  return lines.join('\n');
}

/** RFC 2045 §6.7. A stray `=` is kept literally, as the RFC recommends a robust decoder does. */
function quotedPrintable(binary: string): Uint8Array {
  const text = trimLineEnds(binary);
  // Decoding only shrinks: the output never outgrows the input.
  const out = new Uint8Array(text.length);
  let length = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charCodeAt(at);
    if (char !== 0x3d) {
      out[length++] = char;
      continue;
    }
    if (text.startsWith('\r\n', at + 1)) at += 2;
    else if (text[at + 1] === '\n') at += 1;
    else if (HEX_PAIR.test(text.slice(at + 1, at + 3))) {
      out[length++] = Number.parseInt(text.slice(at + 1, at + 3), 16);
      at += 2;
    } else out[length++] = char;
  }
  return out.slice(0, length);
}

/** A part's body, decoded by its declared Content-Transfer-Encoding (absent is 7bit). */
export function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  const label = (encoding ?? '7bit').trim().toLowerCase();
  if (label === 'base64') return base64(body);
  if (label === 'quoted-printable') return quotedPrintable(body);
  if (label === '7bit' || label === '8bit' || label === 'binary') return bytesOf(body);
  throw inboundMalformed('transfer-encoding');
}

/** Text under its declared charset; a label the runtime does not know reads as UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    // `TextDecoder` refuses an unknown label with a RangeError; the bytes are still text.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decoded bytes of a Q-encoded word (RFC 2047 §4.2): `_` is a space, `=XX` a byte. */
export function qWord(text: string): Uint8Array {
  return quotedPrintable(text.replaceAll('_', ' '));
}

/** Decoded bytes of a B-encoded word, or `undefined` — a bad encoded word is left as written. */
export function bWord(text: string): Uint8Array | undefined {
  try {
    return base64(text);
  } catch {
    return undefined;
  }
}
