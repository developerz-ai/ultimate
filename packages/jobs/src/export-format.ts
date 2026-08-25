// One page of rows -> the bytes that page contributes to the artifact. Pure and synchronous, so
// every hazard in it is testable without a queue, a source or a sink.
//
// The FORMAT is the framework's and the COLUMNS are the app's, which is exactly the line
// `docs/idea/20-large-app-readiness.md` draws for this feature. Quoting and the spreadsheet
// injection guard are identical for a bank and a blog and are the two things every hand-rolled
// CSV exporter gets wrong; which columns leave the building never is.

import { ExportRowInvalidError } from './export-errors';

export const EXPORT_FORMATS = ['ndjson', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The file extension each format's parts carry. `Object.freeze<T>({…})`, so an extra key fails. */
export const EXPORT_EXTENSION = Object.freeze<Record<ExportFormat, string>>({
  ndjson: 'ndjson',
  csv: 'csv',
});

/**
 * What a cell may hold. Deliberately no `Date` and no `Money`: a date without an explicit IANA
 * zone and a money as a float are both build errors everywhere else in this framework, and an
 * export is the one surface where the wrong answer is archived rather than re-rendered. The app
 * formats both before they get here, where it can see which zone and which currency it means.
 */
export type ExportValue = string | number | boolean | null;
export type ExportRecord = Readonly<Record<string, ExportValue>>;

/** Fields a spreadsheet EVALUATES when they lead a cell. See `guardFormula`. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** A cell that would otherwise break the row or the file it sits in. */
const NEEDS_QUOTE = /[",\r\n]/;

export interface EncodePageInput {
  /** The export's name, for a refusal to name. Never rendered into the artifact. */
  readonly subject: string;
  readonly format: ExportFormat;
  /** The declared columns, in order. The header's order and the ndjson key order alike. */
  readonly columns: readonly string[];
  readonly records: readonly ExportRecord[];
  /** True for part 0 only: a csv header belongs in the file once, and parts concatenate. */
  readonly header: boolean;
}

/**
 * Refused rather than coerced, and BOTH directions matter. A missing column silently becomes an
 * empty cell; an undeclared one is silently dropped — and `row: (r) => ({ ...r })` picks up every
 * column the entity gains from the next migration on, which is how a column nobody reviewed leaves
 * the building. Neither is visible in the artifact, which is why it has to be a refusal.
 */
function readCell(input: EncodePageInput, record: ExportRecord, column: string): ExportValue {
  if (!Object.hasOwn(record, column)) {
    throw new ExportRowInvalidError({
      export: input.subject,
      column,
      reason: 'the declared columns name and row() did not answer',
    });
  }
  const value = record[column];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  // FINITE, not merely `typeof 'number'`: `NaN` and `Infinity` land in the file as the words `NaN`
  // and `Infinity`, which no consumer parses back to a number and no reviewer notices in a
  // million-row artifact.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ExportRowInvalidError({
    export: input.subject,
    column,
    reason: 'is not a string, a finite number, a boolean or null',
  });
}

/** Every column, checked, plus a refusal for any key `columns` does not carry. */
function project(input: EncodePageInput, record: ExportRecord): readonly ExportValue[] {
  const cells = input.columns.map((column) => readCell(input, record, column));
  for (const key of Object.keys(record)) {
    if (input.columns.includes(key)) continue;
    throw new ExportRowInvalidError({
      export: input.subject,
      column: key,
      reason: 'row() answered and the declaration does not carry — it would be dropped in silence',
    });
  }
  return cells;
}

/**
 * A leading `=`, `+`, `-`, `@`, TAB or CR makes Excel, Sheets and LibreOffice EVALUATE the cell —
 * so a record a user named `=cmd|'/c calc'!A1` is remote code execution in the reviewer's
 * spreadsheet, and nothing in the exporting app looks wrong. A leading apostrophe is the one
 * portable neutraliser.
 *
 * STRINGS only. Prefixing every leading `-` would turn a refund column into text in every
 * spreadsheet that opened it, which is a data defect traded for a security one.
 */
const guardFormula = (value: string): string => (FORMULA_LEAD.test(value) ? `'${value}` : value);

const csvCell = (value: ExportValue): string => {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  const guarded = guardFormula(value);
  return NEEDS_QUOTE.test(guarded) ? `"${guarded.split('"').join('""')}"` : guarded;
};

/** The csv header line, exported so the manifest and the first part cannot spell it differently. */
export const csvHeader = (columns: readonly string[]): string =>
  `${columns.map((column) => csvCell(column)).join(',')}\n`;

/**
 * The page's bytes. Every line ends in a newline in both formats, so `cat part-0000 part-0001` is
 * a valid file — which is what makes one object per page a legitimate artifact rather than a pile
 * of fragments.
 */
export function encodeExportPage(input: EncodePageInput): Uint8Array {
  const lines: string[] = [];
  if (input.format === 'csv' && input.header) lines.push(csvHeader(input.columns));
  for (const record of input.records) {
    const cells = project(input, record);
    if (input.format === 'csv') {
      lines.push(`${cells.map(csvCell).join(',')}\n`);
      continue;
    }
    // Rebuilt in the declared column order rather than stringifying `record`: an object literal's
    // key order is whatever `row()` happened to write, and two attempts of the same export must
    // produce byte-identical parts — that is what makes a replayed page an overwrite.
    const object: Record<string, ExportValue> = {};
    input.columns.forEach((column, at) => {
      object[column] = cells[at] ?? null;
    });
    lines.push(`${JSON.stringify(object)}\n`);
  }
  return new TextEncoder().encode(lines.join(''));
}
