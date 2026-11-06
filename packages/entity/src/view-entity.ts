// `entity(name, { view: { sql } })`: what a view declaration may not hold, and the record it leaves
// on the entity. A view is a relation Postgres DERIVES — read like a table, written never — so the
// refusals here are the declarations that would promise a write, a trigger or an index Postgres
// has no place for. Writes are refused at the repository seam (`append-only.ts`).

import { EntityError } from './entity-error';
import type { IndexDef } from './types';

/** `entity(…, { view })`. `materialized` stores the rows; `refreshView()` recomputes them. */
export interface ViewInit {
  /** One `select`, the view's whole body. Its output columns are `columns`' physical names. */
  readonly sql: string;
  readonly materialized?: boolean;
}

/** What `$viewQuery` holds: the query and the flag, `null` on every table. */
export interface ViewQuery {
  readonly sql: string;
  readonly materialized: boolean;
}

const refused = (entityName: string, detail: string, fix: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `entity('${entityName}', { view }): ${detail}`,
    fix,
  });

export interface ViewDeclaration {
  readonly appendOnly: boolean;
  readonly indexes: readonly IndexDef[];
  readonly sealed: readonly string[];
}

/**
 * The view, judged where it was written. `;` is refused anywhere but the end: the body is spliced
 * into `create view … as <sql>`, and a second statement there would run with the migration's
 * privileges under a name nobody reviewed as DDL.
 */
export const viewQueryOf = (
  entityName: string,
  init: ViewInit | undefined,
  declared: ViewDeclaration,
): ViewQuery | null => {
  if (init === undefined) return null;
  const sql = init.sql.trim().replace(/;\s*$/, '');
  if (sql.length === 0 || sql.includes(';')) {
    throw refused(
      entityName,
      sql.length === 0 ? 'the query is blank' : 'the query holds more than one statement',
      `entity('${entityName}', { view: { sql: 'select … from <table>' }, columns })   # one select, no ;`,
    );
  }
  const materialized = init.materialized === true;
  if (declared.appendOnly) {
    throw refused(
      entityName,
      'is appendOnly, and nothing writes to a view',
      `entity('${entityName}', { view: { sql }, columns })   # drop appendOnly: true; the source table carries it`,
    );
  }
  const [sealed] = declared.sealed;
  if (sealed !== undefined) {
    throw refused(
      entityName,
      `${sealed} is sealed, and a view's rows are computed by Postgres, which cannot open a sealed value`,
      `entity('${entityName}', { view: { sql }, columns })   # remove .sealed() from ${sealed}; decrypt-and-group is meaningless`,
    );
  }
  if (!materialized && declared.indexes.length > 0) {
    throw refused(
      entityName,
      'declares an index, and Postgres has no index on a plain view',
      `entity('${entityName}', { view: { sql, materialized: true }, columns })   # or drop the index and .unique()`,
    );
  }
  return { sql, materialized };
};
