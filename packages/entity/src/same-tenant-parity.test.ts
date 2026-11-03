// A reference into another tenant, on both drivers. Postgres refuses it with the composite key and
// memory refuses the same row with the same code. The second case is recorded rather than pinned
// equal: memory enforces no foreign key at all, so a parent-less fixture keeps working there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const orgs = entity('stp_orgs', { columns: { id: uuid().primaryKey() } });

const posts = entity('stp_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 40 }),
  },
});

const commentPk = uuid().primaryKey();

const comments = entity('stp_comments', {
  columns: {
    id: commentPk,
    orgId: uuid().tenant(),
    postId: uuid().references(() => posts.id),
    parentId: uuid()
      .nullable()
      .references(() => commentPk),
    sharedPostId: uuid()
      .nullable()
      .references(() => posts.id, { crossTenant: 'a post another org shared with this one' }),
  },
  // What `upsertAll` needs for a tenant-scoped target, and what the self-reference's key reads too.
  indexes: [{ on: ['orgId', 'id'], unique: true }],
});

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG_A = idAt('a');
const ORG_B = idAt('b');
const POST_A = idAt('1a');
const POST_B = idAt('1b');
const MISSING = idAt('ff');

const handle = (driver: Driver) => database({ orgs, posts, comments }, { driver });
type Handle = ReturnType<typeof handle>;

const seedInto = async (db: Handle): Promise<void> => {
  await db.orgs.insertAll([{ id: ORG_A }, { id: ORG_B }]);
  await db.posts.insert({ id: POST_A, orgId: ORG_A, title: 'a' });
  await db.posts.insert({ id: POST_B, orgId: ORG_B, title: 'b' });
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'accepted';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

const VIOLATION = 'X_DB_FOREIGN_KEY_VIOLATION';
const comment = (suffix: string, over: Record<string, unknown> = {}) => ({
  id: idAt(suffix),
  orgId: ORG_A,
  postId: POST_A,
  ...over,
});

let pgDb: Handle;
let memoryDb: Handle;
let memoryOnly: Driver;

beforeAll(async () => {
  const client = await pgliteClient();
  setDbClient(client);
  const { up } = generateMigration({
    entities: [orgs.$describe(), posts.$describe(), comments.$describe()],
    name: 'same-tenant parity',
  });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
  pgDb = handle(postgresDriver());
  memoryOnly = memoryDriver();
  memoryDb = handle(memoryOnly);
  await seedInto(pgDb);
  await seedInto(memoryDb);
}, PGLITE_BOOT_MS);

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

/** One body, both drivers, one answer: a rule only one of them holds is red here. */
const bothAnswer = (name: string, expected: string, body: (db: Handle) => Promise<unknown>) => {
  test(name, async () => {
    expect(await codeOf(() => body(memoryDb))).toBe(expected);
    expect(await codeOf(() => body(pgDb))).toBe(expected);
  });
};

describe('unit · a reference into another tenant', () => {
  bothAnswer('insert', VIOLATION, (db) =>
    db.comments.insert(comment('21', { postId: POST_B }) as never),
  );
  bothAnswer('insertAll, leaving nothing behind', VIOLATION, (db) =>
    db.comments.insertAll([comment('22'), comment('23', { postId: POST_B })] as never),
  );
  bothAnswer('upsertAll', VIOLATION, (db) =>
    db.comments.upsertAll([comment('24', { postId: POST_B })] as never, {
      onConflict: ['orgId', 'id'],
    }),
  );
  bothAnswer('a nullable key naming another tenant', VIOLATION, (db) =>
    db.comments.insert(comment('25', { parentId: idAt('31'), postId: POST_B }) as never),
  );

  test('a batch refused for one row stored none of them', async () => {
    for (const db of [memoryDb, pgDb]) {
      expect(await db.comments.where({ id: idAt('22'), orgId: ORG_A }).one()).toBeNull();
    }
  });

  test('update moving a key onto another tenant', async () => {
    for (const db of [memoryDb, pgDb]) {
      await db.comments.insert(comment('41') as never);
      expect(
        await codeOf(() => db.comments.update(idAt('41'), { postId: POST_B }, { orgId: ORG_A })),
      ).toBe(VIOLATION);
      const kept = await db.comments.where({ id: idAt('41'), orgId: ORG_A }).one();
      expect(kept?.postId).toBe(POST_A);
    }
  });

  test('a self-reference into another tenant', async () => {
    for (const db of [memoryDb, pgDb]) {
      await db.comments.insert(comment('51', { orgId: ORG_B, postId: POST_B }) as never);
      expect(
        await codeOf(() => db.comments.insert(comment('52', { parentId: idAt('51') }) as never)),
      ).toBe(VIOLATION);
    }
  });
});

describe('unit · what stays accepted', () => {
  bothAnswer('the same tenant', 'accepted', (db) => db.comments.insert(comment('61') as never));
  bothAnswer('a null key', 'accepted', (db) =>
    db.comments.insert(comment('62', { parentId: null }) as never),
  );
  bothAnswer('crossTenant: an edge that means it, into a real row', 'accepted', (db) =>
    db.comments.insert(comment('63', { sharedPostId: POST_B }) as never),
  );
  bothAnswer('a batch whose self-reference points forward inside it', 'accepted', (db) =>
    db.comments.insertAll([comment('64', { parentId: idAt('65') }), comment('65')] as never),
  );

  test('a dangling id, recorded: absent is refused on Postgres, memory has no foreign keys', async () => {
    const row = comment('71', { postId: MISSING });
    expect(await codeOf(() => pgDb.comments.insert(row as never))).toBe(VIOLATION);
    expect(await codeOf(() => memoryDb.comments.insert(row as never))).toBe('accepted');
  });

  test('absent and foreign are one answer: no existence oracle', async () => {
    const absent = await pgDb.comments
      .insert(comment('72', { postId: MISSING }) as never)
      .catch((error: unknown) => error);
    const foreign = await pgDb.comments
      .insert(comment('73', { postId: POST_B }) as never)
      .catch((error: unknown) => error);
    if (!isUltimateError(absent) || !isUltimateError(foreign)) {
      expect.unreachable('both inserts refuse');
    }
    expect(absent.code).toBe(foreign.code);
    expect(absent.fix).toBe(foreign.fix);
    expect(absent.meta?.['constraint']).toBe(foreign.meta?.['constraint']);
    const memory = await memoryDb.comments
      .insert(comment('74', { postId: POST_B }) as never)
      .catch((error: unknown) => error);
    if (!isUltimateError(memory)) expect.unreachable('memory refuses too');
    expect(memory.fix).toBe(foreign.fix);
    expect(memory.meta?.['constraint']).toBe(foreign.meta?.['constraint']);
  });
});
