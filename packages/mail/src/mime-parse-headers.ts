// Single responsibility: one MIME header section, read — unfold, split into ordered fields,
// decode RFC 2047 encoded words, and read a structured value's parameters (RFC 2045 §5.1, with
// RFC 2231 continuations and charsets). Bounded by the caller's `maxHeaderBytes`.

import { bWord, bytesOf, decodeCharset, qWord } from './mime-parse-decode';
import { inboundMalformed, inboundTooLarge } from './mime-parse-errors';

export interface HeaderField {
  readonly name: string;
  /** Unfolded, RFC 2047 decoded, trimmed. */
  readonly value: string;
}

/** RFC 5322 §3.6.8: printable ASCII except the colon. */
const FIELD_NAME = /^[!-9;-~]+$/;
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
/** Whitespace BETWEEN two encoded words is not text (RFC 2047 §6.2). */
const BETWEEN_WORDS = /(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g;

/** RFC 2047 words → text. A word that does not decode is kept as written, never refused. */
export function decodeWords(value: string): string {
  return value.replace(BETWEEN_WORDS, '$1').replace(ENCODED_WORD, (word, charset, kind, text) => {
    const label = String(charset).split('*')[0];
    const bytes = String(kind).toUpperCase() === 'B' ? bWord(String(text)) : qWord(String(text));
    return bytes === undefined ? word : decodeCharset(bytes, label);
  });
}

/**
 * The header section (binary string, one char per byte) → fields in order. Raw 8-bit is read as
 * UTF-8 (RFC 6532); a non-blank line with no `name:` is `X_MAIL_INBOUND_MALFORMED`.
 */
export function parseHeaderSection(head: string, maxHeaderBytes: number): readonly HeaderField[] {
  if (head.length > maxHeaderBytes) throw inboundTooLarge('maxHeaderBytes', maxHeaderBytes);
  const fields: HeaderField[] = [];
  const unfolded = head.replace(/\r?\n(?=[\t ])/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trimEnd() : '';
    if (!FIELD_NAME.test(name)) throw inboundMalformed('header');
    const raw = decodeCharset(bytesOf(line.slice(colon + 1)), 'utf-8');
    fields.push({ name, value: decodeWords(raw).trim() });
  }
  return fields;
}

/** The first field named `name`, case-insensitively, as RFC 5322 field names compare. */
export function headerOf(fields: readonly HeaderField[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return fields.find((field) => field.name.toLowerCase() === wanted)?.value;
}

export interface StructuredValue {
  /** Lower-cased: `multipart/mixed`, `attachment`. */
  readonly value: string;
  /** Parameter names lower-cased; values unquoted and decoded. A Map: names are the sender's. */
  readonly params: ReadonlyMap<string, string>;
}

/** Splits on `;` outside double quotes. */
function segments(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let at = 0; at < value.length; at += 1) {
    const char = value.charAt(at);
    if (char === '\\' && quoted) {
      current += char + value.charAt(at + 1);
      at += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

const unquote = (text: string): string =>
  text.startsWith('"') && text.endsWith('"') && text.length >= 2
    ? text.slice(1, -1).replace(/\\(.)/g, '$1')
    : text;

/** RFC 2231 `charset'lang'%XX…` → text. */
function extendedValue(text: string, charset: string | undefined): string {
  const bytes = bytesOf(
    text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  );
  return decodeCharset(bytes, charset);
}

/** `type/subtype; a=b; c*=utf-8''x; d*0=…` → value + parameters. */
export function parseStructured(header: string | undefined): StructuredValue {
  const [head = '', ...rest] = segments(header ?? '');
  const pieces = new Map<string, { index: number; text: string; extended: boolean }[]>();
  for (const segment of rest) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const text = unquote(segment.slice(eq + 1).trim());
    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (match === null) continue;
    const [, base = key, index = '0', star] = match;
    const list = pieces.get(base) ?? [];
    list.push({ index: Number(index), text, extended: star === '*' });
    pieces.set(base, list);
  }
  const params = new Map<string, string>();
  for (const [name, list] of pieces) {
    list.sort((a, b) => a.index - b.index);
    const first = list[0];
    if (first === undefined) continue;
    if (!first.extended) {
      params.set(name, decodeWords(list.map((piece) => piece.text).join('')));
      continue;
    }
    // Only the first extended piece carries `charset'lang'`.
    const [charset, , ...opening] = first.text.split("'");
    const joined = [opening.join("'"), ...list.slice(1).map((piece) => piece.text)].join('');
    params.set(name, extendedValue(joined, charset === '' ? undefined : charset));
  }
  return { value: head.trim().toLowerCase(), params };
}
