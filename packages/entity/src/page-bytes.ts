// Single responsibility: bound a page by BYTES, measured on the rows a driver answered before one
// of them is decoded. `MAX_PAGE_SIZE` bounds rows, and 10,000 rows of a 1 MiB `jsonb` is 10 GiB
// that `decodeRow` would then copy again. Both drivers call `assertPageBytes` on one number, so a
// test against memory refuses the page production would.

import { columnName } from './column';
import type { EntityCore } from './entity';
import { EntityError } from './entity-error';

/**
 * 64 MiB of cells. Measured 2026-11-11 over every `findMany` page in the reference app's and the
 * demo app's suites: the heaviest is 16,560 bytes (120 `users` rows), so the bound sits over three
 * orders of magnitude above every legitimate page, and well below what a container survives once
 * the page is decoded. A constant, as `MAX_PAGE_SIZE` is: the fix for a heavy page is `select()`
 * or a smaller `limit()`, never a wider bound.
 */
export const MAX_PAGE_BYTES = 64 * 1024 * 1024;

/** A number, a boolean, a `Date`, a `null`, an object's or an array's own header. */
const SCALAR_BYTES = 8;

type Cells = Readonly<Record<string, unknown>>;

/**
 * A cell's approximate weight: a string by its length (the wire's bytes for ASCII), binary by its
 * `byteLength`, a parsed `jsonb` walked. Every object visited adds its header, so a cyclic value
 * still grows the total and the walk ends at `stopAt` — a driver never answers one, an app's
 * memory row might.
 */
const cellBytes = (cell: unknown, stopAt: number): number => {
  if (typeof cell === 'string') return cell.length;
  if (cell === null || typeof cell !== 'object' || cell instanceof Date) return SCALAR_BYTES;
  if (ArrayBuffer.isView(cell)) return cell.byteLength;
  let total = 0;
  const pending: unknown[] = [cell];
  while (pending.length > 0 && total <= stopAt) {
    const next = pending.pop();
    if (typeof next === 'string') total += next.length;
    else if (next === null || typeof next !== 'object' || next instanceof Date) {
      total += SCALAR_BYTES;
    } else if (ArrayBuffer.isView(next)) total += next.byteLength;
    else if (next instanceof ArrayBuffer) total += next.byteLength;
    else if (Array.isArray(next)) {
      total += SCALAR_BYTES;
      for (const item of next) pending.push(item);
    } else {
      total += SCALAR_BYTES;
      // `for … in`, not `Object.entries`: measured 0.13 µs against 0.61 µs for a small `jsonb`,
      // and this runs on every page. A parsed `jsonb` is a plain object, so nothing is inherited.
      const record = next as Record<string, unknown>;
      for (const key in record) {
        total += key.length;
        pending.push(record[key]);
      }
    }
  }
  return total;
};

/** How many rows were counted, and what they weighed, stopping at the row that passes `stopAt`. */
const measure = (rows: readonly Cells[], stopAt: number): { bytes: number; counted: number } => {
  let bytes = 0;
  let counted = 0;
  for (const row of rows) {
    for (const key in row) bytes += cellBytes(row[key], stopAt - bytes);
    counted += 1;
    if (bytes > stopAt) break;
  }
  return { bytes, counted };
};

/** What a page weighs, counted until it passes `stopAt` — past that the exact figure buys nothing. */
export const pageBytes = (rows: readonly Cells[], stopAt: number): number =>
  measure(rows, stopAt).bytes;

/** Per column, on the refusal path only: which cell made the page heavy. */
const heaviestColumn = (rows: readonly Cells[], stopAt: number): string | undefined => {
  const weights = new Map<string, number>();
  for (const row of rows) {
    for (const key in row) weights.set(key, (weights.get(key) ?? 0) + cellBytes(row[key], stopAt));
  }
  let heaviest: string | undefined;
  let most = -1;
  for (const [key, weight] of weights) {
    if (weight > most) [heaviest, most] = [key, weight];
  }
  return heaviest;
};

/** A physical name back to the property the author declared; memory rows already use properties. */
const propertyOf = <Row>(entity: EntityCore<Row>, key: string): string => {
  if (key in entity.$columns) return key;
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (columnName(property, column.$meta) === key) return property;
  }
  return key;
};

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Refuses a page heavier than `bound`, before a row of it is decoded. `bound` is the test seam;
 * every driver passes nothing and gets `MAX_PAGE_BYTES`.
 */
export const assertPageBytes = <Row>(
  entity: EntityCore<Row>,
  operation: string,
  rows: readonly Cells[],
  bound: number = MAX_PAGE_BYTES,
): void => {
  const { bytes, counted } = measure(rows, bound);
  if (bytes <= bound) return;
  // Judged on the rows counted before the bound broke, never a recount of the whole page: the
  // refusal must stay as bounded as the read it refuses. Their average row is what sizes `limit`.
  const weighed = rows.slice(0, counted);
  const heavy = heaviestColumn(weighed, bound);
  const heaviest = heavy === undefined ? undefined : propertyOf(entity, heavy);
  const kept = Object.keys(entity.$columns).filter((property) => property !== heaviest);
  const fits = Math.max(1, Math.floor((counted * bound) / bytes));
  // The chain's own spelling — `select({ id: true })` — so the fix pastes onto the read as written.
  const select = `{ ${kept.map((property) => `${property}: true`).join(', ')} }`;
  throw new EntityError({
    code: 'X_ENTITY_PAGE_TOO_LARGE',
    cause: `${entity.$name}.${operation}() answered ${rows.length} rows, and the first ${counted} of them already weigh ${mib(bytes)} MiB before decoding — past the ${mib(bound)} MiB page bound, and every row would be decoded and held at once${heaviest === undefined ? '' : `. '${heaviest}' is the heaviest column`}`,
    fix: `${entity.$name}.where(…).select(${select}).limit(${fits})   # on that read: only the columns the page renders, and a page that fits — or .inBatches(${fits}) to visit every row`,
  });
};
