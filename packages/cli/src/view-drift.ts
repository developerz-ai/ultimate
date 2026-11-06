// Single responsibility: `X_ENTITY_VIEW_DRIFT` — a view entity's declared `columns` against the
// output columns of the view the migrations created. Only a database can say what a query
// outputs, so this reads the `drift` step's scratch replay (`schema-dump-drift.ts`), never source.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { EntityDescriptionLike } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

const named = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

/**
 * One finding per view, naming both directions: a declared column the view does not output is a
 * `42703` on every read; an output no column names is data the entity can never reach. A view the
 * replay did not create is `X_DB_SCHEMA_UNMIGRATED`'s (`schema-diff-views.ts`), and a catalog that
 * carries no columns — one built by hand — states nothing to hold the entity to.
 */
export function viewColumnFindings(
  entities: readonly EntityDescriptionLike[],
  catalog: CatalogDescription,
): readonly Finding[] {
  const created = new Map(catalog.views.map((view) => [view.name, view.columns]));
  return entities.flatMap((entity): readonly Finding[] => {
    if (entity.view === undefined) return [];
    const output = created.get(entity.table);
    if (output === undefined) return [];
    const declared = entity.columns.map((column) => column.column);
    const unproduced = declared.filter((name) => !output.includes(name));
    const unnamed = output.filter((name) => !declared.includes(name));
    if (unproduced.length === 0 && unnamed.length === 0) return [];
    const said = [
      ...(unproduced.length === 0
        ? []
        : [
            `view entity ${entity.name} declares ${named(unproduced)}, which view "${entity.table}" does not output`,
          ]),
      ...(unnamed.length === 0
        ? []
        : [
            `view "${entity.table}" outputs ${named(unnamed)}, which no column of view entity ${entity.name} names`,
          ]),
    ].join('; ');
    return [
      {
        code: 'X_ENTITY_VIEW_DRIFT',
        cause: `${said} — its columns are ${output.join(', ')}`,
        fix: `x entities show ${quoteArg(entity.name)} --json   # then make columns name exactly the view's output, or change view.sql, and run x db gen "record ${entity.table}"`,
        docs: ERROR_DOCS_URL,
        at: MIGRATIONS_DIR,
      },
    ];
  });
}
