// One window of an import's bytes -> its complete records and where the next window starts. Pure
// and synchronous, the twin of `export-format.ts`, so every hazard is testable without a queue.
//
// Records are found on BYTES, never on decoded text: a `\n` (0x0A) and a `"` (0x22) never occur
// inside a UTF-8 multi-byte sequence, so a boundary cut there cannot split a character, and the
// bytes after the last complete record are simply read again by the next window. No carry.

import type { ExportFormat } from './export-format';
import { fileText, ImportHeaderMismatchError, ImportRecordTooLargeError } from './import-errors';

const NEWLINE = 0x0a;
const RETURN = 0x0d;
const QUOTE = 0x22;
const COMMA = 0x2c;
const BOM = [0xef, 0xbb, 0xbf] as const;

/** Why a record was refused before its schema saw it. A rule name, never the record's text. */
export const IMPORT_REJECTIONS = [
  'utf8.invalid',
  'csv.quote_unclosed',
  'csv.quote_stray',
  'csv.field_count',
  'json.syntax',
  'json.not_object',
  'record.undeclared',
] as const;
export type ImportRejection = (typeof IMPORT_REJECTIONS)[number];

/** One complete record: the physical line it starts on (1-based) and its text, or the refusal. */
export interface RawRecord {
  readonly line: number;
  /** `undefined` when the bytes are not UTF-8: refused per row, never a whole-file failure. */
  readonly text: string | undefined;
}

export interface SplitInput {
  readonly subject: string;
  readonly format: ExportFormat;
  /** The window, starting at `offset`. */
  readonly bytes: Uint8Array;
  readonly offset: number;
  /** The physical line `bytes[0]` sits on, 1-based. */
  readonly line: number;
  /** True when the window reaches the end of the object: an unterminated tail is then a record. */
  readonly final: boolean;
  readonly maxRecordBytes: number;
  /** Stop after this many records, so a page of tiny rows is still a bounded statement. */
  readonly maxRecords: number;
}

export interface SplitWindow {
  readonly records: readonly RawRecord[];
  /** Absolute byte offset of the first byte not consumed — the next window's `offset`. */
  readonly next: number;
  readonly nextLine: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const decode = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

const hasBom = (bytes: Uint8Array): boolean => BOM.every((byte, at) => bytes[at] === byte);

/**
 * The complete records in one window. Quote-aware for csv (a newline inside quotes is data);
 * CRLF and LF alike; a UTF-8 BOM at offset 0 is consumed and never part of the first cell; a blank
 * line is skipped. A record longer than `maxRecordBytes` is refused, and so is a full window with
 * no record end in it, because the next read would have to grow.
 */
export function splitRecords(input: SplitInput): SplitWindow {
  const { bytes } = input;
  const records: RawRecord[] = [];
  let start = input.offset === 0 && hasBom(bytes) ? BOM.length : 0;
  let line = input.line;
  let startLine = line;
  let quoted = false;
  // RFC 4180 quotes a FIELD: a `"` opens one only at a field's first byte, and inside one `""` is
  // an escaped quote (close, then re-open at once). Anywhere else it is a literal `parseCsvRecord`
  // refuses for the row alone — flipping on every quote swallowed every later row into one record.
  let fieldStart = true;
  let justClosed = false;

  const take = (end: number): void => {
    if (end - start > input.maxRecordBytes) {
      throw new ImportRecordTooLargeError({
        import: input.subject,
        offset: input.offset + start,
        maxBytes: input.maxRecordBytes,
      });
    }
    const last = end > start && bytes[end - 1] === RETURN ? end - 1 : end;
    if (last > start) records.push({ line: startLine, text: decode(bytes.subarray(start, last)) });
  };

  for (let at = start; at < bytes.length && records.length < input.maxRecords; at += 1) {
    const byte = bytes[at];
    if (input.format === 'csv') {
      const reopens = byte === QUOTE && !quoted && (fieldStart || justClosed);
      justClosed = byte === QUOTE && quoted;
      if (justClosed) quoted = false;
      else if (reopens) quoted = true;
      fieldStart = !quoted && byte === COMMA;
    }
    if (byte !== NEWLINE) continue;
    line += 1;
    if (quoted) continue;
    take(at);
    start = at + 1;
    startLine = line;
    fieldStart = true;
  }
  if (input.final && records.length < input.maxRecords && start < bytes.length) {
    take(bytes.length);
    start = bytes.length;
    startLine = line;
  }
  if (records.length === 0 && !input.final && bytes.length - start > input.maxRecordBytes) {
    // No record end in more than `maxRecordBytes`: reading a longer window is the buffering this
    // refuses. The pass holds every window LONGER than `maxRecordBytes`, so a window that took no
    // record and consumed no blank line always lands here — the loop cannot stand still.
    throw new ImportRecordTooLargeError({
      import: input.subject,
      offset: input.offset + start,
      maxBytes: input.maxRecordBytes,
    });
  }
  return { records, next: input.offset + start, nextLine: startLine };
}

/** One csv field list, RFC 4180: an unquoted empty cell is `null`, a quoted `""` is `''`. */
export function parseCsvRecord(
  text: string,
): { readonly cells: readonly (string | null)[] } | { readonly rejected: ImportRejection } {
  const cells: (string | null)[] = [];
  let at = 0;
  for (;;) {
    if (text[at] === '"') {
      let value = '';
      at += 1;
      for (;;) {
        const close = text.indexOf('"', at);
        if (close < 0) return { rejected: 'csv.quote_unclosed' };
        value += text.slice(at, close);
        if (text[close + 1] === '"') {
          value += '"';
          at = close + 2;
          continue;
        }
        at = close + 1;
        break;
      }
      cells.push(value);
      if (at === text.length) return { cells };
      if (text[at] !== ',') return { rejected: 'csv.quote_stray' };
      at += 1;
      continue;
    }
    const comma = text.indexOf(',', at);
    const value = comma < 0 ? text.slice(at) : text.slice(at, comma);
    if (value.includes('"')) return { rejected: 'csv.quote_stray' };
    cells.push(value === '' ? null : value);
    if (comma < 0) return { cells };
    at = comma + 1;
  }
}

/**
 * Page 0's first record against the declared columns, both directions, as `encodeExportPage`
 * refuses both. Answers the file's column ORDER, which the rows are read by: a spreadsheet that
 * moved a column is still the same file, and a renamed one is the refusal.
 */
export function readCsvHeader(
  subject: string,
  columns: readonly string[],
  record: RawRecord,
): readonly string[] {
  const parsed = record.text === undefined ? undefined : parseCsvRecord(record.text);
  const header = parsed !== undefined && 'cells' in parsed ? parsed.cells.map((c) => c ?? '') : [];
  const seen = new Set<string>();
  const undeclared = header.filter((name) => {
    const repeated = seen.has(name);
    seen.add(name);
    return repeated || !columns.includes(name);
  });
  const missing = columns.filter((name) => !seen.has(name));
  if (missing.length > 0 || undeclared.length > 0 || header.length === 0) {
    throw new ImportHeaderMismatchError({ import: subject, columns, missing, undeclared });
  }
  return header;
}

export type ImportRead =
  | { readonly record: Readonly<Record<string, unknown>> }
  | { readonly rejected: ImportRejection; readonly field: string | null };

/** One record's text -> a keyed object for the schema, or the format's refusal of it. */
export function readImportRecord(
  format: ExportFormat,
  columns: readonly string[],
  text: string | undefined,
): ImportRead {
  if (text === undefined) return { rejected: 'utf8.invalid', field: null };
  if (format === 'csv') {
    const parsed = parseCsvRecord(text);
    if ('rejected' in parsed) return { rejected: parsed.rejected, field: null };
    if (parsed.cells.length !== columns.length) return { rejected: 'csv.field_count', field: null };
    const record: Record<string, unknown> = {};
    columns.forEach((column, at) => {
      record[column] = parsed.cells[at] ?? null;
    });
    return { record };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rejected: 'json.syntax', field: null };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { rejected: 'json.not_object', field: null };
  }
  const object = value as Record<string, unknown>;
  const extra = Object.keys(object).find((key) => !columns.includes(key));
  if (extra !== undefined) return { rejected: 'record.undeclared', field: fileText(extra) };
  return { record: object };
}
