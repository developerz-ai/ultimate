// The pentest finding, inverted, against a real server through the migration `x db gen` writes: an
// actor in org A naming org B's post is refused by the database, and every other row still lands.
// Then the live-table upgrade: the old key holds under writes until the new one validates, and a
// row already crossing tenants fails the validate with the code an operator is told to read.
// Its own tables, as every live file has. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import {
  diffSchema,
  generateMigration,
  introspectSchema,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const posts = entity('stl_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 40 }),
  },
});

const comments = entity('stl_comments', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    postId: uuid()
      .nullable()
      .references(() => posts.id, { onDelete: 'set null' }),
    sharedPostId: uuid()
      .nullable()
      .references(() => posts.id, { crossTenant: 'a post another org shared' }),
  },
  indexes: [{ on: ['orgId', 'id'], unique: true }],
});

/** A reserved word as the column: the catalog prints the list quoted, and that is no drift. */
const reserved = entity('StlReservedName', {
  table: 'stl_reserved',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    userId: uuid()
      .nullable()
      .references(() => posts.id, { onDelete: 'set null' })
      .column('user'),
  },
});

const named = entity('StlNamedChild', {
  table: 'stl_named_child',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    reservedId: uuid().references(() => reserved.id),
  },
});

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG_A = idAt('a');
const ORG_B = idAt('b');
const POST_A = idAt('1a');
const POST_B = idAt('1b');

const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u', orgId }) }), work);

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'accepted';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

const VIOLATION = 'X_DB_FOREIGN_KEY_VIOLATION';

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · same-tenant keys', () => {
  let client: PostgresClient;
  const db = () => database({ posts, comments, reserved, named }, { driver: postgresDriver() });

  const run = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const dropAll = () =>
    client.execute(
      raw(
        'drop table if exists stl_named_child, stl_reserved, stl_comments, stl_posts, stl_up_b, stl_up_a cascade',
      ),
    );

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl as string });
    setDbClient(client);
    await dropAll();
    const { up } = generateMigration({
      entities: [posts.$describe(), comments.$describe(), reserved.$describe(), named.$describe()],
      name: 'same-tenant live',
    });
    await run(up);
    await db().posts.insert({ id: POST_A, orgId: ORG_A, title: 'a' });
    await db().posts.insert({ id: POST_B, orgId: ORG_B, title: 'b' });
  });

  afterAll(async () => {
    await dropAll();
    setDbClient(undefined);
    await client.close();
  });

  const row = (suffix: string, over: Record<string, unknown> = {}) =>
    ({ id: idAt(suffix), orgId: ORG_A, postId: POST_A, sharedPostId: null, ...over }) as never;

  test('insert into another tenant is refused; the same insert into my own lands', async () => {
    await inOrg(ORG_A, async () => {
      expect(await codeOf(() => db().comments.insert(row('21', { postId: POST_B })))).toBe(
        VIOLATION,
      );
      expect(await codeOf(() => db().comments.insert(row('22')))).toBe('accepted');
    });
  });

  test('update moving a key into another tenant is refused', async () => {
    await inOrg(ORG_A, async () => {
      await db().comments.insert(row('31'));
      expect(await codeOf(() => db().comments.update(idAt('31'), { postId: POST_B }))).toBe(
        VIOLATION,
      );
    });
  });

  test('upsertAll into another tenant is refused', async () => {
    await inOrg(ORG_A, async () => {
      expect(
        await codeOf(() =>
          db().comments.upsertAll([row('41', { postId: POST_B })], { onConflict: ['orgId', 'id'] }),
        ),
      ).toBe(VIOLATION);
    });
  });

  test('a raw statement meets the same key: the repo was never what held it', async () => {
    const refused = await client
      .execute(
        sql`insert into stl_comments (id, org_id, post_id) values (${idAt('51')}, ${ORG_A}, ${POST_B})`,
      )
      .catch((error: unknown) => error);
    expect(isUltimateError(refused) ? refused.code : refused).toBe(VIOLATION);
  });

  test('a null key passes, and crossTenant is the edge that means it', async () => {
    await inOrg(ORG_A, async () => {
      expect(await codeOf(() => db().comments.insert(row('61', { postId: null })))).toBe(
        'accepted',
      );
      expect(await codeOf(() => db().comments.insert(row('62', { sharedPostId: POST_B })))).toBe(
        'accepted',
      );
    });
  });

  test('on delete set null empties the key and keeps the tenant', async () => {
    const postId = idAt('71');
    await db().posts.insert({ id: postId, orgId: ORG_A, title: 'gone soon' });
    await inOrg(ORG_A, async () => {
      await db().comments.insert(row('72', { postId }));
      await db().posts.delete(postId);
      const kept = await db()
        .comments.where({ id: idAt('72') })
        .one();
      expect(kept?.postId).toBeNull();
      expect(kept?.orgId).toBe(ORG_A);
    });
  });

  test('a target whose entity name is not its table takes a key', async () => {
    await inOrg(ORG_A, async () => {
      const id = idAt('81');
      await db().reserved.insert({ id, orgId: ORG_A, userId: POST_A });
      await db().named.insert({ id: idAt('82'), orgId: ORG_A, reservedId: id });
      expect(
        await codeOf(() => db().named.insert({ id: idAt('83'), orgId: ORG_A, reservedId: POST_A })),
      ).toBe(VIOLATION);
    });
  });

  test('the catalog reads back what the generator declared: no drift, the set null list too', async () => {
    const live = await introspectSchema({ client });
    const key = live.tables
      .find((table) => table.name === 'stl_comments')
      ?.foreignKeys.find((each) => each.name === 'stl_comments_post_id_tenant_fkey');
    expect(key?.onDelete).toBe('set null (post_id)');
    const expected = generateMigration({
      entities: [posts.$describe(), comments.$describe(), reserved.$describe(), named.$describe()],
      name: 'same-tenant live',
    }).snapshot;
    // The server holds every live suite's tables at once: only this file's own are its question.
    const mine = diffSchema(live, expected).differences.filter(({ table }) =>
      table.startsWith('stl_'),
    );
    expect(mine).toEqual([]);
  });
});

describe.skipIf(!hasPostgres)('live · postgres · onto a live table', () => {
  let client: PostgresClient;

  const scratchA = entity('stl_up_a', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant() },
  });
  const plainChild = () => ({
    ...scratchB.$describe(),
    columns: scratchB
      .$describe()
      .columns.map(({ sameTenant: _gone, ...column }) => ({ ...column, sameTenant: null })),
  });
  const scratchB = entity('stl_up_b', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      aId: uuid().references(() => scratchA.id),
    },
  });

  const run = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const up = () =>
    generateMigration({
      entities: [scratchA.$describe(), plainChild()],
      name: 'before',
    });
  const upgrade = () =>
    generateMigration({
      entities: [scratchA.$describe(), scratchB.$describe()],
      current: up().snapshot,
      name: 'same-tenant keys',
    });
  const reset = async (): Promise<void> => {
    await client.execute(raw('drop table if exists stl_up_b, stl_up_a cascade'));
    await run(up().up);
    await client.execute(sql`insert into stl_up_a (id, org_id) values (${POST_A}, ${ORG_A})`);
    await client.execute(sql`insert into stl_up_a (id, org_id) values (${POST_B}, ${ORG_B})`);
  };
  const child = (suffix: string, target: string) =>
    client.execute(
      sql`insert into stl_up_b (id, org_id, a_id) values (${idAt(suffix)}, ${ORG_A}, ${target})`,
    );

  beforeAll(() => {
    client = postgresClient({ url: adminUrl as string });
    setDbClient(client);
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists stl_up_b, stl_up_a cascade'));
    setDbClient(undefined);
    await client.close();
  });

  const stepsOf = (script: string): readonly string[] => statementsOf(script);

  test('every statement of the step leaves a key on the column; writes never stop being held', async () => {
    await reset();
    await child('1', POST_A);
    for (const statement of stepsOf(upgrade().up)) {
      await client.execute(raw(statement));
      // A dangling id is refused at every point, by the old key and then by either of the two.
      const dangling = await child('ff', idAt('dead')).catch((error: unknown) => error);
      expect(isUltimateError(dangling) ? dangling.code : dangling).toBe(VIOLATION);
    }
    // And past the swap, the row the old key could never have refused.
    const crossing = await child('2', POST_B).catch((error: unknown) => error);
    expect(isUltimateError(crossing) ? crossing.code : crossing).toBe(VIOLATION);
  });

  test('writes keep landing while the step runs', async () => {
    await reset();
    let stop = false;
    let written = 0;
    const writer = (async () => {
      while (!stop) {
        written += 1;
        await child(String(1000 + written), POST_A);
      }
    })();
    for (const statement of stepsOf(upgrade().up)) await client.execute(raw(statement));
    stop = true;
    await writer;
    const landed = await client.query<{ count: unknown }>(
      sql`select count(*) as count from stl_up_b`,
    );
    expect(Number(landed[0]?.count)).toBe(written);
    expect(written).toBeGreaterThan(0);
  });

  test('a row already crossing tenants fails the validate, loud and named', async () => {
    await reset();
    await child('3', POST_B);
    const steps = stepsOf(upgrade().up);
    const failure = await (async () => {
      for (const statement of steps) await client.execute(raw(statement));
      return 'all applied';
    })().catch((error: unknown) => error);
    expect(isUltimateError(failure) ? failure.code : failure).toBe(VIOLATION);
  });

  test('without the unique index the key cannot exist at all', async () => {
    await reset();
    const key = upgrade()
      .up.split('\n')
      .find((line) => line.includes('add constraint'));
    const refused = await client.execute(raw(key ?? '')).catch((error: unknown) => error);
    expect(isUltimateError(refused) ? refused.meta?.['sqlState'] : refused).toBe('42830');
  });

  test('the way back restores the plain key and removes what the upgrade added', async () => {
    await reset();
    await child('4', POST_A);
    const step = upgrade();
    await run(step.up);
    await run(step.down);
    const live = await introspectSchema({ client });
    const keys = live.tables.find((table) => table.name === 'stl_up_b')?.foreignKeys ?? [];
    expect(keys.map((key) => key.name)).toEqual(['stl_up_b_a_id_fkey']);
    const indexes = live.tables.find((table) => table.name === 'stl_up_a')?.indexes ?? [];
    expect(indexes.map((index) => index.name)).not.toContain('stl_up_a_org_id_id_tenant_key');
  });
});
