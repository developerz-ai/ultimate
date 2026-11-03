// The three `X_IMPORT_*` codes an `importRows()` pass can end on. The codes, titles and retry
// classes live in `error-codes.ts`; this file holds only the classes, for the reason
// `export-errors.ts` and `backfill-errors.ts` are split out.
//
// All three are TERMINAL: the same bytes answer the same way on every attempt.

import { UltimateError } from '@ultimat3/core';

const listed = (names: readonly string[]): string =>
  names.length === 0 ? 'none' : names.map((name) => JSON.stringify(name)).join(', ');

/** At most this many undeclared names are shown, each cut to this many characters. */
export const IMPORT_HEADER_SHOWN = 5;
export const IMPORT_HEADER_NAME_CHARS = 40;

/**
 * The ONE rule for a name that is FILE text — a header cell, an undeclared ndjson key — wherever
 * it is reported: cut to `IMPORT_HEADER_NAME_CHARS`, so a 64 KiB cell cannot become a prompt for
 * the agent reading `x jobs show`. Every reader JSON-escapes it (`shown`, the error report's
 * `JSON.stringify`), so a newline in it cannot forge a line either.
 */
export const fileText = (name: string): string =>
  name.length > IMPORT_HEADER_NAME_CHARS ? `${name.slice(0, IMPORT_HEADER_NAME_CHARS)}…` : name;

const shown = (name: string): string => JSON.stringify(fileText(name));

/**
 * A csv header that does not name exactly the declared columns. Both directions, as
 * `encodeExportPage` refuses both: a missing column would arrive as nothing in every row, and an
 * undeclared one is a column the app never agreed to read.
 *
 * `missing` is the DECLARATION's names and is printed whole. `undeclared` is the FILE's text, so
 * it is a count plus a few escaped, truncated names, and the `fix:` carries none of it.
 */
export class ImportHeaderMismatchError extends UltimateError {
  constructor(input: {
    import: string;
    /** The declared columns: what the file's first line must name. */
    columns: readonly string[];
    missing: readonly string[];
    undeclared: readonly string[];
  }) {
    const names = input.undeclared.slice(0, IMPORT_HEADER_SHOWN).map(shown);
    const more = input.undeclared.length - names.length;
    const undeclared =
      names.length === 0 ? 'none' : `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    super({
      code: 'X_IMPORT_HEADER_MISMATCH',
      cause: `import "${input.import}" read a csv header that is missing ${listed(input.missing)} and carries ${input.undeclared.length} undeclared column(s): ${undeclared}`,
      fix: `columns: [${input.columns.map((name) => JSON.stringify(name)).join(', ')}] on importRows("${input.import}") is what the file's first line must name — rewrite the header to it, or declare the file's columns there, then enqueue it again with a new key`,
      meta: {
        missing: [...input.missing],
        undeclaredCount: input.undeclared.length,
        undeclared: names,
      },
    });
  }
}

/**
 * A record with no end inside `maxRecordBytes`. Refused rather than read on: an unclosed quote
 * makes every newline after it part of one cell, and buffering until it closes is how one byte
 * turns a bounded import into the whole file in memory.
 */
export class ImportRecordTooLargeError extends UltimateError {
  constructor(input: { import: string; offset: number; maxBytes: number }) {
    super({
      code: 'X_IMPORT_RECORD_TOO_LARGE',
      cause: `import "${input.import}" found no record end within ${input.maxBytes} bytes of byte offset ${input.offset} — usually a quote opened and never closed`,
      fix: `importRows({ name: "${input.import}", maxRecordBytes: ${input.maxBytes * 2}, … }) if one record really is that large (keep pageBytes above it) — otherwise repair the quote at byte offset ${input.offset} of the file`,
      meta: { offset: input.offset, maxBytes: input.maxBytes },
    });
  }
}

/**
 * More rows refused than `maxRowErrors` allows. The `batch` that crossed the ceiling is NOT handed
 * to `handle`; every refusal so far is already written to the error parts this names.
 */
export class ImportTooManyErrorsError extends UltimateError {
  constructor(input: {
    import: string;
    rejected: number;
    maxRowErrors: number;
    rows: number;
    errorPrefix: string;
    parts: number;
  }) {
    super({
      code: 'X_IMPORT_TOO_MANY_ERRORS',
      cause: `import "${input.import}" refused ${input.rejected} row(s) and allows ${input.maxRowErrors}; ${input.rows} row(s) were handled before it stopped`,
      fix: `x jobs show <id> --json, then read the ${input.parts} errors-*.ndjson part(s) under "${input.errorPrefix}", repair those lines in the file and enqueue importRows("${input.import}") again with a new key`,
      meta: {
        rejected: input.rejected,
        maxRowErrors: input.maxRowErrors,
        rows: input.rows,
        errorPrefix: input.errorPrefix,
        parts: input.parts,
      },
    });
  }
}
