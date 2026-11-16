// The finished row "no exemption debt": every ratchet table is empty, or each of its rows says why
// it stands. A row is reasoned by a non-empty string value, a `why`/`reason` field, a section of
// such strings, or a `// why:` comment directly above (or beside) its key in the table's source.
// A bare count is a debt nobody explained, and it fails the row.

import type { FinishedRow } from './finished-rule';
import { green, isRecord, red } from './finished-rule';
import type { Finding } from './lib/log';
import { lineOf } from './lib/source-scan';

/** An export that is a ratchet, by the names every pin table in this tree carries. */
export const PIN_TABLE_NAME = /(?:_PINS|_UNPINNED|BACKLOG)$/;

export interface PinTableRead {
  /** Repo-relative file the table is declared in. */
  readonly path: string;
  readonly table: string;
  readonly value: unknown;
  readonly source: string;
}

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** A row value that carries its own reason. */
function reasonedValue(value: unknown): boolean {
  if (nonEmpty(value)) return true;
  if (!isRecord(value)) return false;
  if (nonEmpty(value['why']) || nonEmpty(value['reason'])) return true;
  return Object.values(value).every(nonEmpty);
}

/** The line a row's key is written on, or 0 when the source does not spell it out. */
function keyLine(source: string, key: string): number {
  const quoted = new RegExp(
    `(['"\`])${RegExp.escape(key)}\\1|^\\s*${RegExp.escape(key)}\\s*:`,
    'm',
  );
  const at = source.search(quoted);
  return at === -1 ? 0 : lineOf(source, at);
}

/** A `why:` on the key's line, or in the comment block directly above it. */
function commentReason(source: string, line: number): boolean {
  if (line === 0) return false;
  const lines = source.split('\n');
  if (/\/\/.*\bwhy:/.test(lines[line - 1] ?? '')) return true;
  for (let at = line - 2; at >= 0; at -= 1) {
    const text = (lines[at] ?? '').trim();
    if (!text.startsWith('//')) return false;
    if (/\bwhy:/.test(text)) return true;
  }
  return false;
}

const rowsOf = (value: unknown): readonly (readonly [string, unknown])[] => {
  if (Array.isArray(value)) {
    return value.map((row: unknown, index) => [typeof row === 'string' ? row : String(index), row]);
  }
  return isRecord(value) ? Object.entries(value) : [];
};

/** Every unreasoned row of one table, as `[key, line]`. */
export function unreasonedRows(table: PinTableRead): readonly (readonly [string, number])[] {
  const out: (readonly [string, number])[] = [];
  for (const [key, row] of rowsOf(table.value)) {
    const line = keyLine(table.source, key);
    // A string inside an ARRAY is the row's key, not its reason.
    const own = Array.isArray(table.value)
      ? isRecord(row) && reasonedValue(row)
      : reasonedValue(row);
    if (!own && !commentReason(table.source, line)) out.push([key, line]);
  }
  return out;
}

export function pinsRow(tables: readonly PinTableRead[]): FinishedRow {
  const findings: Finding[] = [];
  let rows = 0;
  for (const table of tables) {
    rows += rowsOf(table.value).length;
    const bare = unreasonedRows(table);
    if (bare.length === 0) continue;
    const [firstKey, firstLine] = bare[0] ?? ['', 0];
    const line = firstLine === 0 ? 1 : firstLine;
    const at = `${table.path}:${line}`;
    findings.push({
      code: 'X_FINISHED_PIN_UNREASONED',
      cause: `${table.table} (${table.path}) holds ${bare.length} row(s) with no reason, first "${firstKey}": an exemption nobody explained is debt, not a decision`,
      fix: `edit ${table.path}:${line} — pay the row off (fix the site, delete the row), or write // why: <the reason it stands> above it`,
      at,
    });
  }
  return findings.length === 0
    ? green('no-exemption-debt', `${tables.length} pin tables, ${rows} row(s), every one reasoned`)
    : red('no-exemption-debt', `${findings.length} pin table(s) carry unreasoned rows`, findings);
}
