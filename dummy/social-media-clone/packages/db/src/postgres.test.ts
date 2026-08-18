// unit — the app's schema and its writes, on a real Postgres (PGlite, in this process).
//
// Every other suite in this app runs on the in-memory driver, where an `insert` on an existing
// primary key OVERWRITES and a migration is never executed at all. Both of those are memory-only
// behaviours, so the paths that only exist against a server — apply the schema, replay the seed,
// write a composite key twice, delete one — had no test and shipped broken. One PGlite boot for
// all of it: the boot costs seconds, the statements cost nothing.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPgliteClient, type DbClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { database, postgresDriver } from '@ultimat3/entity';
import { blocks, conversations, friendships, participants, users } from './schema';
import { demo } from './seed';

const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname;

/** The 13 entities `client.ts` names, in the order `information_schema` answers. */
const DECLARED_TABLES = [
  'blocks',
  'comments',
  'conversations',
  'credentials',
  'friendships',
  'likes',
  'media',
  'messages',
  'notifications',
  'participants',
  'posts',
  'sessions',
  'users',
];

let client: DbClient & { close(): Promise<void> };

/** Filename order IS apply order — the id is a sortable timestamp, exactly as the engine reads it. */
const migrationFiles = async (): Promise<readonly string[]> => {
  const names: string[] = [];
  for await (const name of new Bun.Glob('*.sql').scan({ cwd: MIGRATIONS })) names.push(name);
  return names.sort();
};

beforeAll(async () => {
  client = createPgliteClient();
  // The ambient client `postgresDriver()` resolves through. Same install `startServices` performs.
  setDbClient(client);
  const files = await migrationFiles();
  // A migrations directory that lost its files would otherwise pass this whole file by doing
  // nothing — which is exactly the state this app was in: one migration that created no table.
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const sql = await Bun.file(`${MIGRATIONS}${file}`).text();
    // The half above `-- down`, split and sent exactly as `applyScript` sends it
    // (packages/db/src/migrate.ts:280) — one statement per call, because that is all the extended
    // protocol accepts. A test that sent the file whole would fail on syntax and prove nothing.
    for (const statement of statementsOf(sql.split('\n-- down')[0] ?? '')) {
      await client.execute(raw(statement));
    }
  }
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

test('the committed migrations build the entity set the app declares', async () => {
  const rows = await client.query<{ table_name: string }>(
    raw(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    ),
  );
  expect(rows.map((row) => row.table_name)).toEqual(DECLARED_TABLES);
});

/**
 * The failure case first: every role container runs `seedDemo()` at boot, so the second boot — and
 * the hourly reset, and the three other roles booting beside the first — replays the whole graph.
 * A plain insert answers `23505` to that; the memory driver silently overwrote and hid it.
 *
 * The plain `postgresDriver()` is the assertion: this app wrapped it in a decorator of its own
 * until `defineSeed`'s `insert` became an `on conflict do nothing` upsert, and only a real server
 * can tell the framework doing it from nobody doing it.
 */
test('the demo seed replays onto a store that already holds it', async () => {
  const driver = postgresDriver();
  await demo.run({ driver });
  const first = await client.one<{ count: string }>(raw('select count(*) from users'));
  await demo.run({ driver });
  const second = await client.one<{ count: string }>(raw('select count(*) from users'));
  expect(second?.count).toBe(first?.count ?? '');
  expect(Number(second?.count ?? 0)).toBeGreaterThan(0);
});

test('a composite-key row is written, rewritten and removed — the friends feature end to end', async () => {
  const db = database({ blocks, friendships, users }, { driver: postgresDriver() });
  const [ana, ben] = await Promise.all([
    db.users.insert({
      handle: 'pg_ana',
      email: 'pg_ana@fixture.example',
      displayName: 'Ana',
      role: 'member',
    }),
    db.users.insert({
      handle: 'pg_ben',
      email: 'pg_ben@fixture.example',
      displayName: 'Ben',
      role: 'member',
    }),
  ]);

  // The write `saveFriendship` makes twice: ask, then answer. On a server the second one is a
  // primary-key collision unless it is an upsert, which is what the memory driver hid.
  const edge = { requesterId: ana.id, addresseeId: ben.id, status: 'pending' as const };
  await db.friendships.upsertAll([edge], { onConflict: ['requesterId', 'addresseeId'] });
  // `respondedAt` is a literal: `friendship_responded_coherent` requires one for an answered row,
  // and a clock read in a fixture is a test that asserts on wall time.
  await db.friendships.upsertAll(
    [{ ...edge, status: 'accepted' as const, respondedAt: new Date('2026-08-11T12:00:00Z') }],
    { onConflict: ['requesterId', 'addresseeId'] },
  );
  const stored = await db.friendships.where({ requesterId: ana.id, addresseeId: ben.id }).one();
  expect(stored?.status).toBe('accepted');

  // And the row a composite key could not delete until `deleteWhere` landed.
  await db.blocks.upsertAll([{ blockerId: ana.id, blockedId: ben.id }], {
    onConflict: ['blockerId', 'blockedId'],
  });
  expect(await db.blocks.deleteWhere({ blockerId: ana.id, blockedId: ben.id })).toBe(1);
  expect(await db.blocks.where({ blockerId: ana.id, blockedId: ben.id }).one()).toBeNull();
});

/**
 * The other `onMatch`, and the reason it is not `update`: re-adding a member must LEAVE the stored
 * row, because it carries `lastReadAt` and rewriting it would mark a read thread unread. Written
 * here rather than through `apps/web/app/messages/repo.ts` — this package may not import an app.
 */
test('re-adding a thread member changes nothing, and does not collide', async () => {
  const db = database({ conversations, participants, users }, { driver: postgresDriver() });
  const conversation = await db.conversations.insert({ kind: 'direct', title: null });
  const member = await db.users.insert({
    handle: 'pg_cal',
    email: 'pg_cal@fixture.example',
    displayName: 'Cal',
    role: 'member',
  });
  const key = { conversationId: conversation.id, userId: member.id };
  const upsert = { onConflict: ['conversationId', 'userId'] as const, onMatch: 'nothing' as const };

  await db.participants.upsertAll([key], upsert);
  await db.participants.updateWhere(key, { lastReadAt: new Date('2026-08-11T12:00:00Z') });
  // The second add: `nothing` writes no row, so the result is empty AND the read state survives.
  expect(await db.participants.upsertAll([key], upsert)).toHaveLength(0);
  expect((await db.participants.where(key).one())?.lastReadAt).toEqual(
    new Date('2026-08-11T12:00:00Z'),
  );
});
