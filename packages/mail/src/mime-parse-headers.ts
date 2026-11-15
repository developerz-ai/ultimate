// Single responsibility: one MIME header section, read — unfold, split into ordered fields,
// decode RFC 2047 encoded words, and read a structured value's parameters (RFC 2045 §5.1, with
// RFC 2231 continuations and charsets). Bounded by the caller's `maxHeaderBytes`.

import { bWord, bytesOf, decodeCharset, qWord } from './mime-parse-decode';
import { inboundMalformed, inboundTooLarge } from './mime-parse-errors';

export interface HeaderField {
  readonly name: string;
  /** Unfolded, RFC 2047 decoded, trimmed: for display, never for structure. */
  readonly value: string;
  /**
   * Unfolded and trimmed, encoded words as sent. Structure (address lists, parameters) is read
   * from this: a decoded `,` `;` `:` `<` `"` is text, never a delimiter (RFC 2047 §5(3)).
   */
  readonly raw: string;
}

/** RFC 5322 §3.6.8: printable ASCII except the colon. */
const FIELD_NAME = /^[!-9;-~]+$/;
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
const ENCODED_WORD_AT = /=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/y;

/** The encoded word starting at `at`, whole, or `undefined` — a tokenizer keeps it atomic. */
export function encodedWordAt(value: string, at: number): string | undefined {
  if (value.charAt(at) !== '=' || value.charAt(at + 1) !== '?') return undefined;
  ENCODED_WORD_AT.lastIndex = at;
  return ENCODED_WORD_AT.exec(value)?.[0];
}

/**
 * RFC 2047 words → text. Adjacent words (only whitespace between) lose that whitespace (§6.2),
 * and adjacent words of ONE charset are decoded together, so a character split across two words
 * survives. A word that does not decode is kept as written, never refused.
 */
export function decodeWords(value: string): string {
  let out = '';
  let last = 0;
  let group: { charset: string; bytes: number[] } | undefined;
  const flush = (): void => {
    if (group !== undefined) out += decodeCharset(Uint8Array.from(group.bytes), group.charset);
    group = undefined;
  };
  for (const match of value.matchAll(ENCODED_WORD)) {
    const gap = value.slice(last, match.index);
    last = match.index + match[0].length;
    const charset = String(match[1]).split('*')[0]?.toLowerCase() ?? '';
    const text = String(match[3]);
    const bytes = String(match[2]).toUpperCase() === 'B' ? bWord(text) : qWord(text);
    const adjacent = group !== undefined && gap.trim() === '';
    if (bytes === undefined) {
      flush();
      out += gap + match[0];
      continue;
    }
    if (adjacent && group?.charset === charset) {
      group.bytes.push(...bytes);
      continue;
    }
    flush();
    if (!adjacent) out += gap;
    group = { charset, bytes: [...bytes] };
  }
  flush();
  return out + value.slice(last);
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
    const raw = decodeCharset(bytesOf(line.slice(colon + 1)), 'utf-8').trim();
    fields.push({ name, value: decodeWords(raw).trim(), raw });
  }
  return fields;
}

/** The first field named `name`, case-insensitively, as RFC 5322 field names compare. */
export function headerOf(fields: readonly HeaderField[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return fields.find((field) => field.name.toLowerCase() === wanted)?.value;
}

/** The same field's `raw` — what every structured reader (addresses, parameters) parses. */
export function rawHeaderOf(fields: readonly HeaderField[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return fields.find((field) => field.name.toLowerCase() === wanted)?.raw;
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
    const word = encodedWordAt(value, at);
    if (word !== undefined) {
      current += word;
      at += word.length - 1;
    } else if (char === '\\' && quoted) {
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

const percentDecoded = (text: string): string =>
  text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

interface Piece {
  readonly text: string;
  readonly extended: boolean;
}

/**
 * RFC 2231 §3–4: `name*0`, `name*1*`… joined in index order. Only an EXTENDED piece is
 * percent-decoded, and only piece 0 may open with `charset'lang'`; the bytes are decoded once.
 */
function continued(pieces: ReadonlyMap<number, Piece>): string {
  let binary = '';
  let charset: string | undefined;
  for (let index = 0; pieces.has(index); index += 1) {
    const piece = pieces.get(index);
    if (piece === undefined) break;
    let text = piece.text;
    if (piece.extended && index === 0) {
      const [label, , ...rest] = text.split("'");
      if (rest.length > 0) {
        charset = label === '' ? undefined : label;
        text = rest.join("'");
      }
    }
    binary += piece.extended
      ? percentDecoded(text)
      : String.fromCharCode(...new TextEncoder().encode(text));
  }
  return decodeCharset(bytesOf(binary), charset);
}

/**
 * `type/subtype; a=b; c*=utf-8''x; d*0=…` → value + parameters. Read from a RAW header: a plain
 * value is RFC 2047 decoded only after it is split out. An extended `name*` (or `name*0…`) beats
 * a plain `name` — RFC 2231 §4.1's fallback for old readers — and the two never join.
 */
export function parseStructured(header: string | undefined): StructuredValue {
  const [head = '', ...rest] = segments(header ?? '');
  const plain = new Map<string, string>();
  const extended = new Map<string, Map<number, Piece>>();
  for (const segment of rest) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const text = unquote(segment.slice(eq + 1).trim());
    const match = /^([^*]+)(?:\*(\d{1,3}))?(\*)?$/.exec(key);
    if (match === null) continue;
    const [, base = key, index, star] = match;
    if (index === undefined && star === undefined) {
      if (!plain.has(base)) plain.set(base, text);
      continue;
    }
    const pieces = extended.get(base) ?? new Map<number, Piece>();
    const at = index === undefined ? 0 : Number(index);
    if (!pieces.has(at)) pieces.set(at, { text, extended: star === '*' });
    extended.set(base, pieces);
  }
  const params = new Map<string, string>();
  for (const [name, text] of plain) params.set(name, decodeWords(text));
  for (const [name, pieces] of extended) if (pieces.has(0)) params.set(name, continued(pieces));
  return { value: head.trim().toLowerCase(), params };
}
