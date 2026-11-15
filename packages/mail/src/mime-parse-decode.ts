// Single responsibility: the byte-level decodes an inbound part needs — a lossless binary string
// both ways, Content-Transfer-Encoding (base64, quoted-printable, identity), and a charset label
// to text. Each refusal is `X_MAIL_INBOUND_MALFORMED`; an unknown CHARSET is not one (UTF-8 reads it).

import { inboundMalformed } from './mime-parse-errors';

const CHUNK = 8192;

/** Bytes → one char per byte (U+0000–U+00FF). Never `TextDecoder('latin1')`: that is windows-1252. */
export function binaryOf(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.byteLength; at += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return out;
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

/** RFC 2045 §6.7. A stray `=` is kept literally, as the RFC recommends a robust decoder does. */
function quotedPrintable(binary: string): Uint8Array {
  const out: number[] = [];
  const text = binary.replace(/[\t ]+(?=\r?\n)/g, '');
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charCodeAt(at);
    if (char !== 0x3d) {
      out.push(char);
      continue;
    }
    if (text.startsWith('\r\n', at + 1)) at += 2;
    else if (text[at + 1] === '\n') at += 1;
    else if (HEX_PAIR.test(text.slice(at + 1, at + 3))) {
      out.push(Number.parseInt(text.slice(at + 1, at + 3), 16));
      at += 2;
    } else out.push(char);
  }
  return Uint8Array.from(out);
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
