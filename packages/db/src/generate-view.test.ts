// `x db gen` over a view, end to end on the embedded PGlite: the first migration creates the view
// after its table, a changed query rebuilds it AND the view reading it, a retype under a view is
// applied rather than refused (`0A000`), `down` puts every step back, and an unchanged view writes
// nothing. The statements are applied as `migrate()` applies them, one at a time.

import { afterAll, describe, expect, test } from 'bun:test';
import { rowSecurityDifferences } from './drift-row-security';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { touchesViewSources } from './generate-view';
import type { SchemaDescription } from './introspect';
import { pgliteClient } from './pglite';
import { parseSnapshot } from './snapshot-parse';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 30_000;

const column = (
  name: string,
  over: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...over,
});

const likes = (rankKind = 'integer'): EntityDescriptionLike => ({
  name: 'gv_likes',
  table: 'gv_likes',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true }),
    column('post_id', { kind: 'uuid' }),
    column('rank', { kind: rankKind }),
  ],
  indexes: [],
});

const view = (
  name: string,
  sql: string,
  materialized = false,
  indexes: EntityDescriptionLike['indexes'] = [],
): EntityDescriptionLike => ({
  name,
  table: name,
  primaryKey: ['post_id'],
  columns: [
    column('post_id', { kind: 'uuid', primaryKey: true }),
    column('total', { kind: 'bigint' }),
  ],
  indexes,
  view: { sql, ...(materialized ? { materialized: true as const } : {}) },
});

const COUNTS = 'select post_id, sum(rank) as total from gv_likes group by post_id';
const TOTALS = view('gv_totals', COUNTS, true, [
  { name: 'gv_totals_post_id_key', columns: ['post_id'], unique: true, where: null, order: null },
]);
const TOP = view('gv_top', 'select post_id, total from gv_totals where total > 1;');

describe('embedded · pglite · x db gen emits views', () => {
  const client = pgliteClient();
  afterAll(async () => {
    await client.close();
  });

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const read = (name: string) =>
    client.query<{ post_id: string; total: unknown }>(
      raw(`select post_id, total::int as total from ${name} order by post_id`),
    );
  const step = (entities: readonly EntityDescriptionLike[], current?: SchemaDescription) =>
    generateMigration({ entities, current, name: 'views', now: new Date('2026-11-06T00:00:00Z') });

  test(
    'create, rebuild with a dependent, retype underneath, and back down',
    async () => {
      const first = step([likes(), TOTALS, TOP]);
      // Tables before views, and a view after the view it reads — each present first, since a
      // missing needle's -1 would pass the less-than receiver vacuously.
      expect(first.up).toContain('create table');
      expect(first.up).toContain('create materialized view');
      expect(first.up).toContain('"gv_totals" as');
      expect(first.up).toContain('"gv_top" as');
      expect(first.up.indexOf('create table')).toBeLessThan(
        first.up.indexOf('create materialized view'),
      );
      expect(first.up.indexOf('"gv_totals" as')).toBeLessThan(first.up.indexOf('"gv_top" as'));
      // The snapshot survives the sidecar round trip, or the next diff rebuilds forever.
      const recorded = parseSnapshot(JSON.parse(JSON.stringify(first.snapshot)));
      expect(recorded?.views?.map((each) => each.name)).toEqual(['gv_totals', 'gv_top']);
      expect(recorded?.tables.map((table) => table.name)).toEqual(['gv_likes']);
      await apply(first.up);
      const post = '00000000-0000-7000-8000-000000000001';
      await client.execute(
        raw(
          `insert into gv_likes values (gen_random_uuid(), '${post}', 1), (gen_random_uuid(), '${post}', 2)`,
        ),
      );
      await client.execute(raw('refresh materialized view concurrently gv_totals'));
      expect(await read('gv_top')).toEqual([{ post_id: post, total: 3 }]);

      // Nothing moved: nothing written.
      expect(step([likes(), TOTALS, TOP], recorded).up.trim()).toBe('');

      // The materialized view's query changes: it AND the view reading it are rebuilt.
      const changed = view('gv_totals', `${COUNTS} having count(*) > 0`, true, TOTALS.indexes);
      const second = step([likes(), changed, TOP], recorded);
      expect(second.up).toContain('drop view if exists "gv_top";');
      expect(second.up.indexOf('drop view if exists "gv_top"')).toBeLessThan(
        second.up.indexOf('drop materialized view if exists "gv_totals"'),
      );
      await apply(second.up);
      expect(await read('gv_top')).toEqual([{ post_id: post, total: 3 }]);

      // A retype under both views: dropped first, the ALTER, created after — never `0A000`.
      const third = step([likes('bigint'), changed, TOP], second.snapshot);
      expect(third.up).toContain('alter column "rank" type bigint');
      await apply(third.up);
      expect(await read('gv_top')).toEqual([{ post_id: post, total: 3 }]);

      // Every `down` in reverse puts the database back to nothing, views first.
      await apply(third.down);
      await apply(second.down);
      expect(await read('gv_top')).toEqual([{ post_id: post, total: 3 }]);
      await apply(first.down);
      const left = await client.query<{ relname: string }>(
        raw("select relname from pg_class where relname like 'gv_%' and relkind in ('r','v','m')"),
      );
      expect(left).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );

  test('a view removed from the entities is dropped, and no table arm ever sees one', () => {
    const recorded = step([likes(), TOTALS]).snapshot;
    const gone = step([likes()], recorded);
    expect(gone.up).toContain('drop materialized view if exists "gv_totals";');
    expect(gone.snapshot.views).toBeUndefined();
    expect(gone.up).not.toContain('drop table');
  });
});

describe('touchesViewSources', () => {
  test.each([
    ['alter table "t" alter column "c" type bigint using "c"::bigint;', true],
    ['alter table "t" drop column "c";', true],
    ['drop table "t";', true],
    ['alter table "t" add column "c" text;', false],
    ['create index "i" on "t" ("c");', false],
  ])('%s → %p', (statement, touches) => {
    expect(touchesViewSources([statement])).toBe(touches);
  });
});

describe('a tenant view is not a tenant table', () => {
  test('row security asks no policy of it, in x db gen or in drift', () => {
    const tenantView: EntityDescriptionLike = {
      ...view('gv_tenant_view', 'select org_id from gv_likes'),
      columns: [column('org_id', { kind: 'uuid', primaryKey: true })],
      primaryKey: ['org_id'],
    };
    const option = { enabled: true, tenants: [{ table: 'gv_tenant_view', column: 'org_id' }] };
    const migration = generateMigration({
      entities: [likes(), tenantView],
      name: 'tenant view',
      rowSecurity: option,
    });
    expect(migration.up).not.toContain('row level security');
    expect(rowSecurityDifferences([likes(), tenantView], migration.snapshot, option)).toEqual([]);
  });
});
