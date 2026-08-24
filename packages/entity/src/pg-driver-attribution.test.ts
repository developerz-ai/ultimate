// Which entity and which operation compiled the statement, read at the moment it is sent — from
// inside the repository's own scope, which is the only place the answer exists. The recording
// client is not a funnel and notifies no observer, so what the two funnels do with this same read
// is `packages/db`'s (`client.test.ts`, `pglite.test.ts`); this file pins the producer.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  createRecordingClient,
  type DbClient,
  type RecordingClient,
  type SqlFragment,
  type StatementAttribution,
  setDbClient,
  setStatementObserver,
  sql,
  statementAttribution,
} from '@ultimat3/db';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo } from './pg-driver';
import { allColumns } from './pg-row';
import { clearRegistry } from './registry';

const orgs = entity('attr_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/** `(orgId, email)` carries the tenant column, so it is the one target `upsertAll` accepts here. */
const members = entity('attr_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
    role: text({ max: 20 }),
    deletedAt: timestamp().nullable(),
  },
  indexes: [{ on: ['orgId', 'email'], unique: true }],
});

/** Unscoped, because `approximateCount()` is a whole-TABLE estimate and refuses a scoped entity. */
const events = entity('attr_events', {
  columns: { id: uuid().primaryKey(), label: text({ max: 20 }) },
});

const posts = entity('attr_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    title: text({ max: 80 }),
  },
});

type Member = typeof members.$row;

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ORG = idAt(1);
const ANA = idAt(10);
const BEN = idAt(11);

const member = (index: number, over: Partial<Member> = {}): Member => ({
  id: idAt(index),
  orgId: ORG,
  email: `m${index}@example.com`,
  role: 'admin',
  deletedAt: null,
  ...over,
});

/** What Bun.SQL hands back: snake_case names, nothing decoded. */
const memberRow = (id: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  org_id: ORG,
  email: `${id.slice(-2)}@example.com`,
  role: 'admin',
  deleted_at: null,
  ...over,
});

const postRow = (id: string, authorId: string): unknown => ({
  id,
  org_id: ORG,
  author_id: authorId,
  title: `P-${id.slice(-2)}`,
});

/** Filled in the order the statements went out, so `pairs[i]` answers for `recorded.texts[i]`. */
const pairs: (StatementAttribution | undefined)[] = [];

/**
 * Reads `statementAttribution()` where the claim lives — synchronously, at the moment the statement
 * is handed to a client, inside whatever scope the repository opened above it. Recorded before the
 * delegation so a scope that closed on an `await` could not pass this by accident.
 */
const attributing = (inner: RecordingClient): DbClient => ({
  query<T>(fragment: SqlFragment): Promise<readonly T[]> {
    pairs.push(statementAttribution());
    return inner.query<T>(fragment);
  },
  one<T>(fragment: SqlFragment): Promise<T | null> {
    pairs.push(statementAttribution());
    return inner.one<T>(fragment);
  },
  execute(fragment: SqlFragment): Promise<number> {
    pairs.push(statementAttribution());
    return inner.execute(fragment);
  },
});

let recorded: RecordingClient;
let client: DbClient;

beforeEach(() => {
  recorded = createRecordingClient();
  client = attributing(recorded);
  pairs.length = 0;
  setDbClient(client);
  // Any observer opens the gate — which one is not what this file tests, and with none installed
  // the scope is never entered at all (the last test here is that branch).
  setStatementObserver({ onStatement: () => undefined });
});

afterEach(() => {
  setStatementObserver(undefined);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const memberRepo = () => postgresRepo(members);
const postRepo = () => postgresRepo(posts);
const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: idAt(90), orgId: ORG }) }), work);

/** One stub set every method here can be served by, so no test's setup is its own assertion. */
const stubEverything = (): void => {
  recorded.on('from "attr_members"', { rows: [memberRow(ANA)] });
  recorded.on('count(', { rows: [{ count: '1' }] });
  recorded.on('group by', { rows: [{ group_value: 'admin', group_count: '1' }] });
  recorded.on('agg_value', { rows: [{ agg_value: null, agg_count: '0' }] });
  recorded.on('reltuples', { rows: [{ estimate: '7' }] });
  recorded.on('insert into "attr_members"', { rows: [memberRow(idAt(30))] });
  // `update … set` is three statements' text here: `update`, and the soft-delete stamp both
  // `delete` and `deleteWhere` compile to — so it answers with a row AND with a count.
  recorded.on('update "attr_members"', { rows: [memberRow(ANA, { role: 'owner' })], affected: 1 });
};

const pairFor = (op: string) => ({ entity: 'attr_members', op });

/** Every method on `Repo`, so a method added without attribution is a failing test, not a review. */
const calls: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['findById', () => memberRepo().findById(ANA, { orgId: ORG })],
  ['findMany', () => memberRepo().findMany({ orgId: ORG })],
  ['count', () => memberRepo().count({ orgId: ORG })],
  ['countBy', () => memberRepo().countBy('role', { orgId: ORG })],
  ['insert', () => memberRepo().insert(member(30))],
  ['insertAll', () => memberRepo().insertAll([member(31), member(32)])],
  [
    'upsertAll',
    () => memberRepo().upsertAll([member(33)], { onConflict: ['orgId', 'email'] as const }),
  ],
  ['update', () => memberRepo().update(ANA, { role: 'owner' }, { orgId: ORG })],
  ['delete', () => memberRepo().delete(ANA, { orgId: ORG })],
  ['deleteWhere', () => memberRepo().deleteWhere({ role: 'admin' }, { orgId: ORG })],
  [
    'updateWhere',
    () => memberRepo().updateWhere({ role: 'admin' }, { role: 'owner' }, { orgId: ORG }),
  ],
  // `aggregate` names itself by the FUNCTION, not by the method: a diagnostic reporting "50x
  // aggregate on members" would not say which one, and `min` and `sum` are different statements
  // with different costs. `deletedAt` because it is the one column here `min` accepts.
  ['min', () => memberRepo().aggregate('min', 'deletedAt', { orgId: ORG })],
];

describe('every repository method names the statement it sends', () => {
  for (const [op, run] of calls) {
    test(`${op} sends its statement inside { attr_members, ${op} }`, async () => {
      stubEverything();

      await run();

      expect(recorded.statements).toHaveLength(1);
      expect(pairs).toEqual([pairFor(op)]);
    });
  }

  test('the read an empty patch degrades to is still attributed to update', async () => {
    stubEverything();

    await memberRepo().update(ANA, {}, { orgId: ORG });

    expect(recorded.texts[0]).toStartWith('select');
    expect(pairs).toEqual([pairFor('update')]);
  });

  test('a batch past the bind count is several statements, each one attributed', async () => {
    stubEverything();
    // Computed, never a magic number: the limit is Postgres's and the width is this entity's.
    const perStatement = Math.floor(MAX_BIND_PARAMETERS / allColumns(members).length);
    const batch = Array.from({ length: perStatement + 2 }, (_, index) => member(index + 1000));

    await memberRepo().insertAll(batch);

    expect(recorded.statements).toHaveLength(2);
    expect(pairs).toEqual([pairFor('insertAll'), pairFor('insertAll')]);
  });

  test('the pair is gone once the call returns — nothing leaks into the next statement', async () => {
    stubEverything();

    await memberRepo().count({ orgId: ORG });
    await client.query(sql`select 1`);

    expect(pairs).toEqual([pairFor('count'), undefined]);
  });
});

describe('a shared statement carries the pair every call it replaced would have carried', () => {
  test('one microtask of point lookups is one statement, attributed to findById', async () => {
    recorded.on('from "attr_members"', { rows: [memberRow(ANA), memberRow(BEN)] });

    await inRequest(() =>
      Promise.all([
        memberRepo().findById(ANA, { orgId: ORG }),
        memberRepo().findById(BEN, { orgId: ORG }),
      ]),
    );

    // Flushed from a `queueMicrotask` scheduled inside the scope, so nobody threads the pair there.
    expect(recorded.texts[0]).toContain('"id" in ($1, $2)');
    expect(pairs).toEqual([pairFor('findById')]);
  });

  test("a page's sibling preload belongs to the lookup that triggered it, not to the page", async () => {
    recorded.on('from "attr_posts"', { rows: [postRow(idAt(20), ANA), postRow(idAt(21), BEN)] });
    recorded.on('from "attr_members"', { rows: [memberRow(ANA), memberRow(BEN)] });

    await inRequest(async () => {
      const page = await postRepo().findMany({ orgId: ORG });
      // A `for … of` awaits between iterations, so only the page these rows came from can batch it.
      for (const post of page.rows) await memberRepo().findById(post.authorId, { orgId: ORG });
    });

    expect(recorded.statements).toHaveLength(2);
    expect(pairs).toEqual([{ entity: 'attr_posts', op: 'findMany' }, pairFor('findById')]);
  });

  test('a preloaded relation is attributed to the related entity, never to the read above it', async () => {
    recorded.on('from "attr_posts"', { rows: [postRow(idAt(20), ANA), postRow(idAt(21), BEN)] });
    recorded.on('from "attr_members"', { rows: [memberRow(ANA), memberRow(BEN)] });
    const db = database({ orgs, members, posts }, { driver: postgresDriver() });

    await db.posts.where({ orgId: ORG }).preload('author').all();

    // `preload()` reads through the related entity's own repo, so the pair is that call's own.
    expect(pairs).toEqual([
      { entity: 'attr_posts', op: 'findMany' },
      { entity: 'attr_members', op: 'findMany' },
    ]);
  });
});

describe('what carries no pair', () => {
  test('approximateCount names itself, on the only kind of entity that can ask', async () => {
    // Not in the table above: every fixture entity there is tenant-scoped, and a whole-table
    // estimate of a tenant-scoped table is refused before a statement exists. So the method's
    // attribution needs an unscoped entity, and this is it.
    stubEverything();

    await postgresRepo(events).approximateCount();

    expect(recorded.statements).toHaveLength(1);
    expect(pairs).toEqual([{ entity: 'attr_events', op: 'approximateCount' }]);
  });

  test('hand-written SQL through the same client is unattributed', async () => {
    await client.query(sql`select now()`);
    await client.execute(sql`delete from "attr_members" where "role" = ${'ghost'}`);

    expect(pairs).toEqual([undefined, undefined]);
  });

  test('a refusal never opens the scope: the statement it would have named is never sent', async () => {
    stubEverything();

    // Unscoped on a tenant-scoped entity — the plan is built before the send is attributed.
    await expect(memberRepo().findMany({})).rejects.toThrow();

    expect(recorded.statements).toHaveLength(0);
    expect(pairs).toEqual([]);
  });

  // Axiom 6: an app with no diagnostic installed pays one property read and one branch, and the
  // producer allocates nothing. A regression to "always enter the scope" fails right here.
  test('with no observer installed the scope is never entered', async () => {
    stubEverything();
    setStatementObserver(undefined);

    await memberRepo().findById(ANA, { orgId: ORG });
    await memberRepo().insert(member(30));

    expect(recorded.statements).toHaveLength(2);
    expect(pairs).toEqual([undefined, undefined]);
  });
});
