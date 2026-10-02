// Single responsibility: build a schema from the dump `schema-dump.ts` wrote — every file's
// statements, in kind order, inside one transaction. The inverse of the dump and the half of
// "load equals replay" that proves the files are a cache of the migrations rather than a second
// source: load, introspect, render again, and the bytes must be the ones that were loaded.

import { renderThrowable } from '@ultimat3/core';
import type { DbClient } from './client';
import { baseClient } from './client';
import { schemaDumpDrift, unloadableDump } from './dump-drift';
import { DbError } from './errors';
import { FRAMEWORK_DUMP_DIR, type SchemaDumpFile } from './schema-dump';
import { raw } from './sql';
import { SQLSTATE, sqlState } from './sqlstate';
import { statementsOf } from './statement-split';
import { withTransaction } from './transaction';

export interface LoadSchemaDumpOptions {
  readonly files: readonly SchemaDumpFile[];
  readonly client?: DbClient | undefined;
}

export interface SchemaLoadReport {
  readonly files: number;
  readonly statements: number;
}

/** One loadable unit: a whole file, or the numbered parts of a split one joined back together. */
interface Unit {
  readonly path: string;
  readonly kind: string;
  readonly framework: boolean;
  readonly script: string;
}

const SPLIT_PART = /^(.*)\.(\d+)\.sql$/;

/**
 * Files regrouped into units and put in load order: by kind directory, the framework twin first
 * within a kind (an app's foreign key may point at `x_users`; nothing of the framework's points at
 * the app), then by name. A split file's parts are joined in NUMERIC order — `.10.sql` after
 * `.9.sql` — because a statement may straddle the cut.
 */
export function loadOrder(files: readonly SchemaDumpFile[]): readonly Unit[] {
  const parts = new Map<string, { part: number; content: string }[]>();
  for (const file of files) {
    const match = SPLIT_PART.exec(file.path);
    const base = match === null ? file.path : `${match[1] ?? ''}.sql`;
    const list = parts.get(base) ?? [];
    list.push({ part: match === null ? 0 : Number(match[2]), content: file.content });
    parts.set(base, list);
  }
  const units = [...parts.entries()].map(([path, list]): Unit => {
    const framework = path.startsWith(`${FRAMEWORK_DUMP_DIR}/`);
    const local = framework ? path.slice(FRAMEWORK_DUMP_DIR.length + 1) : path;
    return {
      path,
      kind: local.includes('/') ? (local.split('/')[0] ?? '') : '',
      framework,
      script: list
        .sort((a, b) => a.part - b.part)
        .map((part) => part.content)
        .join(''),
    };
  });
  const key = (unit: Unit): string => `${unit.kind}/${unit.framework ? '0' : '1'}/${unit.path}`;
  return units.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** "Not created YET" — the three states a statement raises when it names something later in the order. */
const NOT_YET: ReadonlySet<string> = new Set([
  SQLSTATE.undefinedTable,
  SQLSTATE.undefinedFunction,
  SQLSTATE.undefinedObject,
]);

const detailOf = (error: unknown): string =>
  error instanceof DbError ? error.cause : renderThrowable(error);

/**
 * Load every file. A unit that fails because something it names does not exist yet is rolled back
 * to its savepoint and retried after the rest — kind order is right for nearly every schema, and
 * the exceptions (a view over a view, a column default calling a function) are dependencies no
 * directory layout can order. A pass that loads nothing ends the loop with the last refusal.
 *
 * `check_function_bodies` is off for the transaction: a SQL-language function body is validated
 * at creation, and it may name a table an alphabetical neighbour has not created.
 */
export async function loadSchemaDump(options: LoadSchemaDumpOptions): Promise<SchemaLoadReport> {
  const client = options.client ?? baseClient();
  let pending = loadOrder(options.files);
  const files = pending.length;
  let statements = 0;
  await withTransaction(
    async (tx) => {
      await tx.execute(raw('set local check_function_bodies = off'));
      while (pending.length > 0) {
        const deferred: Unit[] = [];
        let refusal: DbError | undefined;
        for (const unit of pending) {
          const script = statementsOf(unit.script);
          try {
            await withTransaction(async (savepoint) => {
              for (const statement of script) await savepoint.execute(raw(statement));
            });
            statements += script.length;
          } catch (error) {
            refusal = schemaDumpDrift(unloadableDump(unit.path, detailOf(error)));
            if (!NOT_YET.has(sqlState(error) ?? '')) throw refusal;
            deferred.push(unit);
          }
        }
        if (deferred.length === pending.length && refusal !== undefined) throw refusal;
        pending = deferred;
      }
    },
    { client },
  );
  return { files, statements };
}
