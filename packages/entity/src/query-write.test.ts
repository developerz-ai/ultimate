// The chain's write terminals: `db.x.where(…).updateAll(patch)` and `.deleteAll()` write exactly the rows
// the same chain's `.all()` reads — any operator, the same tenant — in ONE statement, and answer
// with a count. `updateWhere`/`deleteWhere` are the same write spelled with an equality filter.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';

const posts = entity('query_write_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

type Post = typeof posts.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const AT = new Date('2026-02-01T00:00:00.000Z');

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;

const seed: readonly Post[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    id: id(index),
    orgId: ORG,
    title: `Post ${index}`,
    likeCount: index,
    updatedAt: AT,
  })),
  // Same id range, another tenant: an `in` naming it must still not reach it.
  { id: id(9), orgId: OTHER, title: 'Theirs', likeCount: 9, updatedAt: AT },
];

const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u-1', orgId: ORG }) }), fn);

let repo = memoryRepo(posts, seed);
let table = tableFor(posts, repo);
let client: RecordingClient;

beforeEach(() => {
  repo = memoryRepo(posts, seed);
  table = tableFor(posts, repo);
  client = recordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const titles = async (org: string): Promise<string[]> =>
  (await repo.findMany({ orgId: org, limit: 10 })).rows.map((row) => row.title);

describe('chain .updateAll(patch)', () => {
  test('an in-list writes exactly the listed rows, stamps onUpdateNow, and counts them', async () => {
    const written = await asOrg(() =>
      table.andWhere('id', 'in', [id(1), id(3)]).updateAll({ title: 'Edited' }),
    );
    expect(written).toBe(2);
    expect(await titles(ORG)).toEqual(['Post 0', 'Edited', 'Post 2', 'Edited', 'Post 4']);
    const stamped = (await repo.findById(id(1), { orgId: ORG }))?.updatedAt;
    expect(stamped?.getTime()).not.toBe(AT.getTime());
  });

  test('any operator bounds it, as on the read path', async () => {
    const chain = table.where({ orgId: ORG }).andWhere('likeCount', 'gte', 3);
    expect(await chain.count()).toBe(2);
    expect(await chain.updateAll({ likeCount: 0 })).toBe(2);
    expect(await table.where({ orgId: ORG }).andWhere('likeCount', 'eq', 0).count()).toBe(3);
  });

  test('another tenant is untouched, even by an id it names', async () => {
    const written = await asOrg(() =>
      table.andWhere('id', 'in', [id(0), id(9)]).updateAll({ title: 'Mine' }),
    );
    expect(written).toBe(1);
    expect(await titles(OTHER)).toEqual(['Theirs']);
  });

  test('an empty chain and an empty patch are refused, and nothing is written', async () => {
    await expect(table.where({}).updateAll({ title: 'All' })).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    await expect(
      table.where({ orgId: ORG }).updateAll({ title: undefined }),
    ).rejects.toBeUltimateError('X_PATCH_EMPTY');
    expect(await titles(ORG)).toEqual(['Post 0', 'Post 1', 'Post 2', 'Post 3', 'Post 4']);
  });

  test('a page on a write chain is refused, never written in full', async () => {
    await expect(
      table.where({ orgId: ORG }).limit(1).updateAll({ title: 'First' }),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    await expect(
      table.where({ orgId: ORG }).after('cursor').updateAll({ title: 'Rest' }),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(await titles(ORG)).not.toContain('First');
  });

  test('updateWhere is the same write spelled with an equality filter', async () => {
    expect(await table.updateWhere({ id: id(2) }, { title: 'Same' }, { orgId: ORG })).toBe(1);
    expect(await table.where({ orgId: ORG, id: id(4) }).updateAll({ title: 'Same' })).toBe(1);
    expect(await titles(ORG)).toEqual(['Post 0', 'Post 1', 'Same', 'Post 3', 'Same']);
  });
});

describe('chain .deleteAll()', () => {
  test('an in-list removes exactly the listed rows and counts them', async () => {
    expect(
      await table
        .where({ orgId: ORG })
        .andWhere('id', 'in', [id(0), id(4)])
        .deleteAll(),
    ).toBe(2);
    expect(await titles(ORG)).toEqual(['Post 1', 'Post 2', 'Post 3']);
  });

  test('another tenant is untouched, even by an id it names', async () => {
    expect(await asOrg(() => table.andWhere('id', 'in', [id(9), id(1)]).deleteAll())).toBe(1);
    expect(await titles(OTHER)).toEqual(['Theirs']);
  });

  test('an empty chain is refused before tenancy runs', async () => {
    await expect(asOrg(() => table.where({}).deleteAll())).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    // No actor and no org: a tenant-scoped write never becomes a query.
    await expect(table.andWhere('likeCount', 'gt', 0).deleteAll()).rejects.toBeUltimateError(
      'X_TENANCY_UNSCOPED',
    );
    expect(await titles(ORG)).toHaveLength(5);
  });
});

describe('an undefined chain predicate', () => {
  const missing: string | undefined = undefined;

  test('is refused by deleteAll and updateAll, never dropped to widen the write', async () => {
    await expect(
      asOrg(() => table.where({ orgId: ORG, id: missing }).deleteAll()),
    ).rejects.toBeUltimateError('X_WRITE_UNFILTERED');
    await expect(
      asOrg(() => table.where({ id: missing }).updateAll({ title: 'All' })),
    ).rejects.toBeUltimateError('X_WRITE_UNFILTERED');
    expect(await titles(ORG)).toEqual(['Post 0', 'Post 1', 'Post 2', 'Post 3', 'Post 4']);
  });

  test('updateWhere keeps dropping it, as it always has', async () => {
    expect(
      await table.updateWhere({ title: 'Post 2', id: missing }, { title: 'Kept' }, { orgId: ORG }),
    ).toBe(1);
    expect(await titles(ORG)).toContain('Kept');
  });
});

describe('on Postgres, one statement', () => {
  test('a chain delete is one statement carrying the list and the tenant', async () => {
    client.on('delete from', { affected: 2 });
    const pg = tableFor(posts, postgresRepo(posts));
    expect(await asOrg(() => pg.andWhere('id', 'in', [id(0), id(1)]).deleteAll())).toBe(2);
    expect(client.statements).toHaveLength(1);
    const text = client.texts[0] ?? '';
    expect(text).toStartWith('delete from "query_write_posts" where "id" in (');
    expect(text).toContain('"org_id" = $');
    expect(client.statements[0]?.values).toEqual([id(0), id(1), ORG]);
  });

  test('a chain update is one statement, no returning, stamped', async () => {
    client.on('update', { affected: 3 });
    const pg = tableFor(posts, postgresRepo(posts));
    const written = await asOrg(() =>
      pg.andWhere('likeCount', 'lt', 3).updateAll({ title: 'Low' }),
    );
    expect(written).toBe(3);
    expect(client.statements).toHaveLength(1);
    const text = client.texts[0] ?? '';
    expect(text).toStartWith('update "query_write_posts" set "title" = $1, "updated_at" = $2');
    expect(text).toContain('"like_count" < $3 and "org_id" = $4');
    expect(text).not.toContain('returning');
  });

  test('a refused chain sends nothing', async () => {
    const pg = tableFor(posts, postgresRepo(posts));
    await expect(asOrg(() => pg.where({}).deleteAll())).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    await expect(
      asOrg(() => pg.where({ orgId: ORG }).limit(10).deleteAll()),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(client.statements).toHaveLength(0);
  });
});
