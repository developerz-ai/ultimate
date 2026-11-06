// Test-only: the entity descriptions the lifecycle live suites generate migrations from — a parent
// with history and a counter, its history table, and a soft-deletable child. Physical names only,
// as `@ultimat3/entity` would hand them across the tier seam.

import type { DbClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const col = (column: string, kind: string, notNull = true, extra = {}): ColumnDescriptionLike => ({
  property: column,
  column,
  kind,
  notNull,
  primaryKey: column === 'id',
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...extra,
});

/** `<prefix>_posts` counting `<prefix>_likes`, with history into `<prefix>_posts_history`. */
export function lifecycleEntities(prefix: string): readonly EntityDescriptionLike[] {
  const posts = `${prefix}_posts`;
  const likes = `${prefix}_likes`;
  const history = `${posts}_history`;
  return [
    {
      name: posts,
      table: posts,
      primaryKey: ['id'],
      columns: [
        col('id', 'uuid'),
        col('org_id', 'uuid'),
        col('title', 'text'),
        col('like_count', 'integer', true, {
          hasDefault: true,
          default: { kind: 'value', value: 0 },
        }),
      ],
      indexes: [],
      history: { table: history, key: 'id', tenant: 'org_id', ignore: ['like_count'] },
      counts: [
        {
          column: 'like_count',
          key: 'id',
          table: likes,
          references: 'post_id',
          softDelete: 'deleted_at',
        },
      ],
    },
    {
      name: history,
      table: history,
      primaryKey: ['id'],
      columns: [
        col('id', 'uuid'),
        col('org_id', 'uuid'),
        col('row_id', 'text'),
        col('op', 'text'),
        col('at', 'timestamptz'),
        col('actor_id', 'text', false),
        col('request_id', 'text', false),
        col('before', 'jsonb', false),
        col('after', 'jsonb', false),
      ],
      indexes: [],
    },
    {
      name: likes,
      table: likes,
      primaryKey: ['id'],
      columns: [
        col('id', 'uuid'),
        col('org_id', 'uuid'),
        col('post_id', 'uuid', true, { references: `${posts}.id`, onDelete: 'cascade' }),
        col('deleted_at', 'timestamptz', false),
      ],
      indexes: [],
    },
  ];
}

/** Drops the three tables, then generates and applies their first migration. */
export async function applyLifecycle(client: DbClient, prefix: string): Promise<string> {
  for (const table of [`${prefix}_likes`, `${prefix}_posts_history`, `${prefix}_posts`]) {
    await client.execute(raw(`drop table if exists "${table}" cascade`));
  }
  const migration = generateMigration({
    entities: lifecycleEntities(prefix),
    name: 'lifecycle',
    now: new Date('2026-11-06T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  return migration.down;
}
