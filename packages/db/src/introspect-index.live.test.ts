// The key parts against a real server: what `createIndex` writes for an expression key, mixed
// directions, INCLUDE and `gin_trgm_ops`, read back by `introspectSchema` and compared by
// `diffSchema` — clean as built, red after a hand rebuild. Its own table, dropped in and out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { diffSchema } from './drift';
import type { IndexDescriptionLike } from './entity-shape';
import { createIndex } from './index-ddl';
import { requiredExtension } from './index-key-ddl';
import { findTable, type IndexDescription, introspectSchema } from './introspect';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const TABLE = 'x_ikprobe_users';

const plain = { unique: false, where: null, order: null } as const;
const DECLARED: readonly IndexDescriptionLike[] = [
  { ...plain, name: 'ikprobe_email', columns: ['email'], unique: true, expression: 'lower(email)' },
  { ...plain, name: 'ikprobe_feed', columns: ['org', 'at'], orders: [null, 'desc'] },
  { ...plain, name: 'ikprobe_cover', columns: ['org'], include: ['name'] },
  {
    ...plain,
    name: 'ikprobe_trgm',
    columns: ['name'],
    using: 'gin',
    operatorClass: 'gin_trgm_ops',
  },
];
const recorded = (index: IndexDescriptionLike): IndexDescription => {
  const { concurrently: _c, ...rest } = index;
  return { ...rest, primary: false };
};

describe.skipIf(!hasPostgres)('index key parts on Postgres', () => {
  let client: PostgresClient;
  const drift = async () => {
    const live = findTable(await introspectSchema({ client }), TABLE);
    expect(live).toBeDefined();
    if (live === undefined) return [];
    const ours = { ...live, indexes: live.indexes.filter((i) => i.name.startsWith('ikprobe_')) };
    const expected = { ...ours, indexes: DECLARED.map(recorded) };
    return diffSchema({ tables: [ours] }, { tables: [expected] }).differences;
  };

  beforeAll(async () => {
    client = postgresClient({ url: url as string });
    await client.execute(raw(`drop table if exists ${TABLE}`));
    await client.execute(
      raw(`create table ${TABLE} (id int primary key, email text, org int, at int, name text)`),
    );
    for (const index of DECLARED) {
      const extension = requiredExtension(index);
      if (extension !== null)
        await client.execute(raw(`create extension if not exists ${extension}`));
      await client.execute(raw(createIndex(TABLE, index)));
    }
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists ${TABLE}`));
    await client.close();
  });

  test('every part reads back, and the table is clean against its declaration', async () => {
    const live = findTable(await introspectSchema({ client }), TABLE);
    const byName = new Map(live?.indexes.map((index) => [index.name, index]));
    expect(byName.get('ikprobe_email')?.columns).toEqual(['(lower(email))']);
    expect(byName.get('ikprobe_feed')?.orders).toEqual([null, 'desc']);
    expect(byName.get('ikprobe_cover')?.include).toEqual(['name']);
    expect(byName.get('ikprobe_cover')?.columns).toEqual(['org']);
    expect(byName.get('ikprobe_trgm')?.operatorClass).toBe('gin_trgm_ops');
    // A plain index carries none of the parts, so no existing snapshot reads differently.
    const pkey = byName.get(`${TABLE}_pkey`);
    expect(Object.keys(pkey ?? {}).sort()).toEqual(
      ['columns', 'name', 'order', 'primary', 'unique', 'using', 'where'].sort(),
    );
    expect(await drift()).toEqual([]);
  });

  test('a hand rebuild of each part is drift', async () => {
    await client.execute(raw('drop index ikprobe_cover'));
    await client.execute(raw(`create index ikprobe_cover on ${TABLE} (org)`));
    await client.execute(raw('drop index ikprobe_feed'));
    await client.execute(raw(`create index ikprobe_feed on ${TABLE} (org, at)`));
    const causes = (await drift()).map((difference) => difference.cause).join('\n');
    expect(causes).toContain('includes no columns');
    expect(causes).toContain('orders its keys (asc, asc)');
  });
});
