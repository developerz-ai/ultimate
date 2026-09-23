// Physical Postgres row -> the entity row the app declared, by `@ultimat3/entity`'s own decoder.
// The relation names the table, `entityForTable` names the entity, and `decodeRow` shapes the row
// by each column's declared KIND — money included — exactly as a repository read does.
//
// It GUESSED, until 22.0.0: snake_case camelCased by string rules and any `<p>_minor`/`<p>_currency`
// pair folded into money by name. So a nullable money column diverged from the repository shape,
// two plain columns that happened to be called `x_minor`/`x_currency` were folded into a `Money`,
// and a `.column()` rename arrived under its physical name. One decoder, the entity's, now.

import { decodeRow, entityForTable } from '@ultimat3/entity';
import { ReplicationProtocolError } from './errors';
import type { PhysicalRow } from './pg-values';
import type { PgRelation } from './pgoutput';

/**
 * A key-only `before` image — any replica identity but FULL — carries NULL for every column that is
 * not part of the key. Those NULLs are not the row's values, and handed to the decoder a not-null
 * column would read as a table that no longer matches its entity. They are dropped, so the image
 * decodes as what it is: the key, and nothing claimed about the rest.
 */
function replicatedOnly(relation: PgRelation, physical: PhysicalRow): PhysicalRow {
  if (relation.replicaIdentity === 'f') return physical;
  const keys = new Set(relation.columns.filter((column) => column.key).map((c) => c.name));
  const kept: PhysicalRow = {};
  for (const [name, value] of Object.entries(physical)) {
    if (value !== null || keys.has(name)) kept[name] = value;
  }
  return kept;
}

/**
 * The entity row for one replicated tuple. A relation with no registered entity is refused: the
 * stream only selects tables `replicatedRelations()` named from the entity registry, so one that
 * arrives unregistered is a process that never loaded the app's entities.
 */
export function entityRow(
  relation: PgRelation,
  physical: PhysicalRow,
  image: 'before' | 'after',
): PhysicalRow {
  const entity = entityForTable(relation.name);
  if (entity === undefined) {
    throw new ReplicationProtocolError({
      stage: 'value',
      detail: `table "${relation.name}" has no registered entity, so its rows cannot be decoded`,
      fix: 'load the app before starting the replicator — runRole({ root, env }) does — or drop the table from the entity list',
    });
  }
  const source = image === 'before' ? replicatedOnly(relation, physical) : physical;
  return decodeRow(entity, source) as PhysicalRow;
}
