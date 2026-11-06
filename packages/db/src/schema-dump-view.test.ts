// The schema dump over views `x db gen` WROTE, on the embedded PGlite: a materialized view with
// its unique index and a plain view reading it both reach `07_views/`, and load-equals-replay
// holds — the dump loaded into an empty schema dumps to the same bytes, and the loaded
// materialized view is still one `refresh … concurrently` accepts.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { introspectCatalog } from './introspect-catalog';
import { pgliteClient } from './pglite';
import { renderSchemaDump } from './schema-dump';
import { loadSchemaDump } from './schema-load';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 60_000;

const column = (name: string, kind: string, primaryKey = false): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind,
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const likes: EntityDescriptionLike = {
  name: 'sdv_likes',
  table: 'sdv_likes',
  primaryKey: ['id'],
  columns: [column('id', 'uuid', true), column('post_id', 'uuid')],
  indexes: [],
};

const totals: EntityDescriptionLike = {
  name: 'sdv_totals',
  table: 'sdv_totals',
  primaryKey: ['post_id'],
  columns: [column('post_id', 'uuid', true), column('likes', 'integer')],
  indexes: [
    {
      name: 'sdv_totals_post_id_key',
      columns: ['post_id'],
      unique: true,
      where: null,
      order: null,
    },
  ],
  view: {
    sql: 'select post_id, count(*)::integer as likes from sdv_likes group by post_id',
    materialized: true,
  },
};

const popular: EntityDescriptionLike = {
  name: 'sdv_popular',
  table: 'sdv_popular',
  primaryKey: ['post_id'],
  columns: [column('post_id', 'uuid', true), column('likes', 'integer')],
  indexes: [],
  view: { sql: 'select post_id, likes from sdv_totals where likes > 1' },
};

const client = pgliteClient();
const dump = async () => renderSchemaDump(await introspectCatalog({ client }));

beforeAll(async () => {
  const { up } = generateMigration({ entities: [likes, totals, popular], name: 'views' });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(() => client.close());

test(
  'generated views are dumped, and the dump loads back to the same bytes',
  async () => {
    const replayed = await dump();
    const views = replayed.filter((file) => file.path.startsWith('07_views/'));
    expect(views.map((file) => file.path)).toEqual([
      '07_views/sdv_popular.sql',
      '07_views/sdv_totals.sql',
    ]);
    const materialized = views.find((file) => file.path === '07_views/sdv_totals.sql');
    expect(materialized?.content).toContain('create materialized view "sdv_totals" as');
    // The index rides in the view's own file: `05_indexes` loads before any view exists.
    expect(materialized?.content).toContain('CREATE UNIQUE INDEX sdv_totals_post_id_key');

    await client.execute(raw('drop schema public cascade'));
    await client.execute(raw('create schema public'));
    await loadSchemaDump({ client, files: replayed });
    expect(await dump()).toEqual(replayed);
    // Loaded, not merely described: the unique index is real, so a concurrent refresh is accepted.
    await client.execute(
      raw('insert into sdv_likes values (gen_random_uuid(), gen_random_uuid())'),
    );
    await client.execute(raw('refresh materialized view concurrently sdv_totals'));
    expect(await client.query(raw('select likes from sdv_totals'))).toEqual([{ likes: 1 }]);
  },
  PGLITE_BOOT_MS,
);

test('the catalog reads each view’s output columns in order, and the dump never renders them', async () => {
  const catalog = await introspectCatalog({ client });
  expect(catalog.views.map((view) => [view.name, view.columns])).toEqual([
    ['sdv_popular', ['post_id', 'likes']],
    ['sdv_totals', ['post_id', 'likes']],
  ]);
  const { columns: _, ...unread } = catalog.views[0] ?? expect.unreachable('two views');
  expect(renderSchemaDump({ ...catalog, views: [unread] })).toEqual(
    renderSchemaDump({ ...catalog, views: [catalog.views[0] ?? unread] }),
  );
});
