// Single responsibility: serialise a `MailMessage` into the raw RFC 5322 / MIME text the SMTP
// transport writes to `DATA` — header order, RFC 2047 subject encoding, header folding and
// quoted-printable body encoding. Pure: no I/O, no clock read beyond the `Date` it is given.

import { instant, toZoned, UTC } from '@ultimat3/time';
import { base64Utf8 } from './base64';
import { type MailMessage, messageHeaders } from './driver';
import { headerInvalid } from './errors';

export interface MimeOptions {
  /** `Postly <no-reply@postly.test>` or a bare `no-reply@postly.test`. */
  readonly from: string;
  /** The full `Message-ID` header value, angle brackets included: `<abc@postly.test>`. */
  readonly messageId: string;
  readonly date: Date;
  /** multipart boundary token; the driver generates it. */
  readonly boundary: string;
}

const CRLF = '\r\n';
/** RFC 5322's soft line-fold target for headers. */
const MAX_FOLD_LINE = 78;
/** RFC 2045's hard line-length cap for quoted-printable, the trailing `=` included. */
const MAX_QP_LINE = 76;
/** RFC 2047: an encoded-word (prefix + payload + suffix) may not exceed this. */
const MAX_ENCODED_WORD = 75;
const ENCODED_WORD_PREFIX = '=?UTF-8?B?';
const ENCODED_WORD_SUFFIX = '?=';
// The largest byte chunk whose base64 form still fits the encoded-word budget above.
const MAX_CHUNK_BYTES =
  Math.floor((MAX_ENCODED_WORD - ENCODED_WORD_PREFIX.length - ENCODED_WORD_SUFFIX.length) / 4) * 3;

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The complete RFC 5322 message: headers, blank line, multipart/alternative body. CRLF throughout. */
export function buildMimeMessage(message: MailMessage, options: MimeOptions): string {
  const headerLines: string[] = [];
  // Every header goes through one gate, so the CR/LF injection check cannot be forgotten by
  // whichever header is added next. The check runs on the RAW value: encoding first would let a
  // non-ASCII subject hide a line break inside an encoded word instead of refusing it, so the
  // same input would be accepted or rejected depending on whether it happened to be ASCII.
  const header = (name: string, value: string, encode = false): void => {
    if (value.includes('\r') || value.includes('\n')) throw headerInvalid(name, message.mailId);
    headerLines.push(foldHeaderLine(name, encode ? encodeHeaderValue(value) : value));
  };

  header('From', options.from);
  header('To', message.to.join(', '));
  if (message.cc !== undefined && message.cc.length > 0) header('Cc', message.cc.join(', '));
  header('Subject', message.subject, true);
  header('Date', rfc5322Date(options.date));
  header('Message-ID', options.messageId);
  header('MIME-Version', '1.0');
  // RFC 8058 one-click unsubscribe and friends: computed once in driver.ts, emitted verbatim
  // here so there is exactly one place that decides which of these headers a message gets.
  for (const [name, value] of Object.entries(messageHeaders(message))) header(name, value);
  header('Content-Type', `multipart/alternative; boundary="${options.boundary}"`);

  return `${headerLines.join(CRLF)}${CRLF}${CRLF}${buildBody(message, options.boundary)}`;
}

/** multipart/alternative: text first, html second — clients render the last part they understand. */
function buildBody(message: MailMessage, boundary: string): string {
  return (
    `--${boundary}${CRLF}` +
    bodyPart('text/plain', message.text) +
    `--${boundary}${CRLF}` +
    bodyPart('text/html', message.html) +
    `--${boundary}--${CRLF}`
  );
}

function bodyPart(contentType: string, text: string): string {
  return (
    `Content-Type: ${contentType}; charset=utf-8${CRLF}` +
    `Content-Transfer-Encoding: quoted-printable${CRLF}` +
    CRLF +
    `${quotedPrintable(text)}${CRLF}`
  );
}

/** `Postly <no-reply@postly.test>` -> `no-reply@postly.test`. A bare address is returned as-is. */
export function addressSpec(address: string): string {
  const match = /<([^<>]+)>\s*$/.exec(address);
  return match?.[1] ?? address;
}

/** The domain half of an address spec, for building a `Message-ID`. */
export function addressDomain(address: string): string {
  const spec = addressSpec(address);
  const at = spec.lastIndexOf('@');
  return at === -1 ? spec : spec.slice(at + 1);
}

/** RFC 2047 `=?UTF-8?B?…?=` when the value is not pure ASCII, otherwise the value unchanged. */
export function encodeHeaderValue(value: string): string {
  if (isPureAscii(value)) return value;
  // Encoded-words are joined by a plain space, not a hard fold: RFC 2047 says any linear
  // whitespace between adjacent encoded-words is discarded on decode, so `foldHeaderLine`
  // is free to turn that space into a CRLF continuation later without changing the meaning.
  return utf8Chunks(value)
    .map((chunk) => `${ENCODED_WORD_PREFIX}${base64Utf8(chunk)}${ENCODED_WORD_SUFFIX}`)
    .join(' ');
}

/** Splits `text` on whole code points so no chunk's UTF-8 form exceeds `MAX_CHUNK_BYTES`. */
function utf8Chunks(text: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (chunk !== '' && chunkBytes + charBytes > MAX_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

// A `\xNN` regex range trips Biome's control-character lint, so ASCII-ness is a byte scan.
function isPureAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * `Name: value` folded to <= 78 chars per line with CRLF + single space continuations. The value
 * is copied through, never re-spaced: unfolding restores exactly one space per fold point, so a
 * subject that legitimately holds a run of spaces survives the round trip. A value with no fold
 * point (one very long URL) stays over-long rather than being broken mid-token.
 */
export function foldHeaderLine(name: string, value: string): string {
  const lines: string[] = [];
  let remainder = `${name}: ${value}`;
  // The space after the colon is not a fold point, and neither is a continuation's own leading
  // space: folding there would emit a line holding nothing but the field name.
  let earliest = name.length + 1;
  while (remainder.length > MAX_FOLD_LINE) {
    const at = remainder.lastIndexOf(' ', MAX_FOLD_LINE);
    if (at <= earliest) break;
    lines.push(remainder.slice(0, at));
    remainder = ` ${remainder.slice(at + 1)}`;
    earliest = 0;
  }
  lines.push(remainder);
  return lines.join(CRLF);
}

/** RFC 2045 quoted-printable, CRLF line endings, soft breaks at 76 chars. */
export function quotedPrintable(text: string): string {
  // Collapse any line-ending style down to `\n` first, then re-expand to `\r\n` — the only
  // way to guarantee a bare `\n` becomes `\r\n` without ever doubling an existing `\r\n`.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(encodeQpLine).join(CRLF);
}

function encodeQpLine(line: string): string {
  const tokens = [...new TextEncoder().encode(line)].map((byte) =>
    isQpLiteral(byte) ? String.fromCharCode(byte) : qpEscape(byte),
  );
  protectTrailingWhitespace(tokens);
  return wrapQpTokens(tokens);
}

function isQpLiteral(byte: number): boolean {
  if (byte === 0x09 || byte === 0x20) return true; // tab, space — protected below if trailing
  return byte >= 33 && byte <= 126 && byte !== 0x3d; // printable ASCII, '=' excluded
}

function qpEscape(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** A trailing run of literal space/tab risks silent loss in transit; escape all of it. */
function protectTrailingWhitespace(tokens: string[]): void {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token !== ' ' && token !== '\t') break;
    tokens[index] = qpEscape(token.charCodeAt(0));
  }
}

/** Greedily packs tokens (never split) into <= 76-char lines, reserving one column for `=`. */
function wrapQpTokens(tokens: string[]): string {
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line.length + token.length > MAX_QP_LINE - 1) {
      lines.push(`${line}=`);
      line = '';
    }
    line += token;
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** `Tue, 09 Aug 2026 12:34:56 +0000` — always UTC, and the zone is stated, never ambient. */
export function rfc5322Date(at: Date): string {
  const zoned = toZoned(instant(at), UTC);
  // weekday is ISO 1-7 and month is 1-12 by ZonedDateTime's own contract, so these never miss;
  // the fallback exists only to satisfy noUncheckedIndexedAccess.
  const weekday = WEEKDAY_NAMES[zoned.weekday - 1] ?? 'Mon';
  const month = MONTH_NAMES[zoned.month - 1] ?? 'Jan';
  const date = `${pad2(zoned.day)} ${month} ${zoned.year}`;
  const time = `${pad2(zoned.hour)}:${pad2(zoned.minute)}:${pad2(zoned.second)}`;
  return `${weekday}, ${date} ${time} +0000`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
