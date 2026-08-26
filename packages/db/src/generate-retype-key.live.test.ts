// Single responsibility: a retype of a column a FOREIGN KEY is written against, applied to a real
// server. Postgres re-checks a key's two ends against each other on every `alter column … type` and
// cannot rebuild one whose sides stopped matching: measured, `42804 foreign key constraint
// "rk_posts_org_code_fkey" cannot be implemented` — thrown by the ALTER itself, inside
// `ROLE=migrate`, with the ledger recording nothing and every statement after it unapplied.
//
// A string comparison cannot tell you that did not happen, which is why this file applies the
// generated SQL in both directions instead of matching it.
//
// Every table here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const ORGS = 'rk_orgs';
const POSTS = 'rk_posts';
const KEY = `${POSTS}_org_code_fkey`;

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

/** The key's TARGET. `code` is what moves; every other part is identical across the two versions. */
const orgs = (kind: string): EntityDescriptionLike => ({
  name: 'RkOrg',
  table: ORGS,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('code', { kind, notNull: true, unique: true }),
  ],
  indexes: [],
});

/** The key's OWNER — and it lives in this table's record, which `diffTable(orgs)` cannot see. */
const posts = (kind: string): EntityDescriptionLike => ({
  name: 'RkPost',
  table: POSTS,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_code', { kind, references: `${ORGS}.code` }),
  ],
  indexes: [],
});

const at = new Date('2026-08-25T00:00:00.000Z');
const uuid = (tail: string): string => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

describe.skipIf(!hasPostgres)(
  'live · postgres · retyping a column a foreign key depends on',
  () => {
    let client: PostgresClient;

    const apply = async (script: string): Promise<void> => {
      for (const statement of statementsOf(script)) await client.execute(raw(statement));
    };

    const typeOf = async (table: string, name: string): Promise<string> => {
      const rows = await client.query<{ format_type: string }>(
        raw(
          `select format_type(a.atttypid, a.atttypmod) from pg_attribute a ` +
            `join pg_class t on t.oid = a.attrelid where t.relname = '${table}' ` +
            `and a.attname = '${name}'`,
        ),
      );
      return rows[0]?.format_type ?? '';
    };

    const keyNames = async (): Promise<readonly string[]> => {
      const rows = await client.query<{ conname: string }>(
        raw(
          `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
            `where t.relname = '${POSTS}' and c.contype = 'f' order by conname`,
        ),
      );
      return rows.map((row) => row.conname);
    };

    const teardown = async (): Promise<void> => {
      await client.execute(raw(`drop table if exists "${POSTS}" cascade`));
      await client.execute(raw(`drop table if exists "${ORGS}" cascade`));
    };

    beforeAll(async () => {
      client = createPostgresClient({ url: url ?? '' });
      await teardown();
      await apply(
        generateMigration({ entities: [orgs('integer'), posts('integer')], name: 'init', now: at })
          .up,
      );
      await client.execute(raw(`insert into "${ORGS}" ("id", "code") values ('${uuid('a')}', 7)`));
      await client.execute(
        raw(`insert into "${POSTS}" ("id", "org_code") values ('${uuid('1')}', 7)`),
      );
    });

    afterAll(async () => {
      await teardown();
      await client.close();
    });

    // Both ends move together, because a key whose sides stopped matching is a key Postgres will not
    // rebuild in any order — see the file header in `retype-keys.ts`.
    const retype = () =>
      generateMigration({
        entities: [orgs('text'), posts('text')],
        current: snapshotOf([orgs('integer'), posts('integer')]),
        name: 'code to text',
        now: at,
      });

    test('the constraint is dropped BEFORE the first alter and added back after the last', () => {
      const statements = statementsOf(retype().up);
      const dropped = statements.findIndex((each) => each.includes(`drop constraint "${KEY}"`));
      const added = statements.findIndex((each) => each.includes(`add constraint "${KEY}"`));
      const alters = statements
        .map((each, index) => (each.includes('alter column') ? index : -1))
        .filter((index) => index >= 0);
      expect(dropped).toBeGreaterThanOrEqual(0);
      expect(added).toBeGreaterThanOrEqual(0);
      expect(alters.length).toBe(2);
      expect(dropped).toBeLessThan(Math.min(...alters));
      expect(added).toBeGreaterThan(Math.max(...alters));
    });

    test('the whole migration APPLIES — the retype does not abort on 42804', async () => {
      await apply(retype().up);
      expect(await typeOf(ORGS, 'code')).toBe('text');
      expect(await typeOf(POSTS, 'org_code')).toBe('text');
    });

    test('the key is back, and it still refuses a row pointing at no org', async () => {
      expect(await keyNames()).toEqual([KEY]);
      await expect(
        client.execute(
          raw(`insert into "${POSTS}" ("id", "org_code") values ('${uuid('2')}', 'nope')`),
        ),
      ).rejects.toThrow();
    });

    test('every row survived the rewrite', async () => {
      const rows = await client.query<{ org_code: string }>(
        raw(`select "org_code" from "${POSTS}" order by "id"`),
      );
      expect(rows.map((row) => row.org_code)).toEqual(['7']);
    });

    test('and its down reverses the whole thing — back to integer, key intact', async () => {
      await apply(retype().down);
      expect(await typeOf(ORGS, 'code')).toBe('integer');
      expect(await typeOf(POSTS, 'org_code')).toBe('integer');
      expect(await keyNames()).toEqual([KEY]);
    });

    // The half no other arm reaches. The key's own table is dropped by this migration, so nothing
    // retypes its column and `foreignKeyPlan` is never called for it — and `drop table "rk_posts"`
    // is emitted at the END of `up`, long after the ALTER it would have unblocked. Measured with
    // the target-side arm of `breaksOn` removed: `42804` on `alter table "rk_orgs"`, statement one.
    test('dropping the child and retyping the parent in one migration still applies', async () => {
      const dropChild = generateMigration({
        entities: [orgs('text')],
        current: snapshotOf([orgs('integer'), posts('integer')]),
        name: 'drop posts and retype code',
        now: at,
        allowDestructive: true,
      });
      await apply(dropChild.up);
      expect(await typeOf(ORGS, 'code')).toBe('text');
      expect(await typeOf(POSTS, 'org_code')).toBe('');
      // The reversal says so rather than pretending: a constraint whose table no `down` can
      // restore is a note, which is the rule `unrestorableDrop` already writes.
      expect(dropChild.down).toContain(`-- constraint "${KEY}" on "${POSTS}"`);
    });
  },
);
