// Single responsibility: what a `copyAll` batch may be, decided in PROPERTY space so every driver
// refuses the same batch. `COPY … FROM STDIN` has one column list and no per-row `default` cell,
// so a column one row writes and another leaves out has no honest spelling — refused here, in
// memory and behind `defineDriver` too, rather than accepted where it happens to work.

import type { EntityCore } from './entity';
import { EntityError } from './errors';
import type { RowPatch } from './types';

/** Present and not `undefined` — the two tests `bindValues` makes before it binds a value. */
const writes = (row: unknown, property: string): boolean =>
  typeof row === 'object' &&
  row !== null &&
  Object.hasOwn(row, property) &&
  (row as Readonly<Record<string, unknown>>)[property] !== undefined;

const unevenCopy = (entityName: string, position: number, missing: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.copyAll() row ${position + 1} does not name "${missing}", which other rows of the batch do — COPY writes one column list for every row and has no per-row default`,
    fix: `${entityName}.copyAll(rows.map((row) => ({ ...row, ${missing}: <value> })))   # or ${entityName}.insertAll(rows, { returning: false }), which writes default per cell`,
  });

/**
 * The properties every row of the batch writes, in declaration order. Empty when no row writes
 * anything: every column then takes its default, which a COPY spells by naming none of them.
 */
export const copyColumns = <Row>(
  entity: EntityCore<Row>,
  rows: readonly RowPatch<Row>[],
): readonly string[] => {
  const properties = Object.keys(entity.$columns).filter((property) =>
    rows.some((row) => writes(row, property)),
  );
  for (const [position, row] of rows.entries()) {
    const missing = properties.find((property) => !writes(row, property));
    if (missing !== undefined) throw unevenCopy(entity.$name, position, missing);
  }
  return properties;
};
