// The `subscribe` fixture end to end: a real entity, a real `query({ live: true })`, a real
// in-process `sync` node, and a write that has to arrive at a subscriber as a patch.
//
// It is written against the whole stack on purpose. A test that drove `LiveQueryRegistry` with a
// hand-built definition would prove the registry works — which `@ultimat3/realtime`'s own suites
// already do — and say nothing about the two joins this driver adds: `setRowObserver` seeing a
// committed write, and `liveQueryDefinition` turning a declared query into something subscribable.

import { afterEach, beforeEach, test as bunTest, describe, expect } from 'bun:test';
import { type Actor, createContext, runWithContext, userActor } from '@ultimat3/core';
import { database, defaultDriver, entity, setRowObserver, text, uuid } from '@ultimat3/entity';
import { can, definePermissions, defineRoles } from '@ultimat3/policy';
import { from, query, registerQueries, resetRegistry, t } from '@ultimat3/query';
import { createSubscribeDriver, type SubscribeDriver } from './fixture-subscribe';
import { testName } from './test-types';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const TINTA = '00000000-0000-4000-8000-0000000000b1';

const notes = entity('notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 40 }),
  },
});

const db = database({ notes });

// A real permission and a real role, because the whole point of the driver is that the
// per-subscriber gate runs — a stub policy would make every one of these tests pass with the gate
// removed.
definePermissions(['note:read']);
defineRoles({ member: { grants: ['note:read'] } });

/** Tenant-scoped and bounded, which `live: true` requires — an unbounded live query is a leak. */
const liveNotes = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('note:read'),
  live: true,
  sql: ({ orgId }) =>
    from<{ id: string; orgId: string; title: string }>('notes', async () => {
      const page = await db.notes.where({ orgId }).orderBy('id').limit(50).page();
      return page.rows;
    })
      .where({ orgId })
      .orderBy('id')
      .limit(50),
});

const member = (id: string, orgId: string): Actor => userActor({ id, orgId, roles: ['member'] });

/**
 * Writes run under a context carrying the actor, because that is what an app does — an action
 * installs one before it touches a repository. A tenant-scoped entity refuses a write built with no
 * org predicate and no actor to take one from (`X_TENANCY_UNSCOPED`), so a test writing bare would
 * be testing a call no app makes.
 */
const as = <T>(actor: Actor, work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor }), work);

const NOTE_ONE = '00000000-0000-4000-8000-000000000001';
const NOTE_TWO = '00000000-0000-4000-8000-000000000002';
const NOTE_FAR = '00000000-0000-4000-8000-000000000003';

const seed = async (): Promise<void> => {
  await as(member('m1', ACME), async () => {
    await db.notes.insert({ id: NOTE_ONE, orgId: ACME, title: 'one' });
    await db.notes.insert({ id: NOTE_TWO, orgId: ACME, title: 'two' });
  });
  await as(member('m2', TINTA), () =>
    db.notes.insert({ id: NOTE_FAR, orgId: TINTA, title: 'far' }),
  );
};

describe(testName('unit', 'the subscribe fixture drives a whole sync node'), () => {
  let driver: SubscribeDriver;

  beforeEach(async () => {
    // The memory driver is process-wide, so fresh is something each test does rather than
    // something a new object gives it — the same call `examples/dummy`'s seed fixture makes.
    defaultDriver().reset?.();
    resetRegistry();
    registerQueries({ liveNotes });
    driver = await createSubscribeDriver();
    await seed();
  });

  afterEach(async () => {
    await driver.stop();
    resetRegistry();
    // The observer is process-global and `driver.stop()` restores what it replaced; this is the
    // belt for a test that threw between `createSubscribeDriver` and here.
    setRowObserver(null);
  });

  bunTest('the snapshot is the rows the query reads, and only those', async () => {
    const feed = await driver.subscribe<{ id: string; orgId: string; title: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );
    expect(feed.rows().map((row) => row.title)).toEqual(['one', 'two']);
    expect(feed.snapshots()).toBe(1);
    expect(feed.patches()).toEqual([]);
  });

  // The join this whole driver exists for. Without `setRowObserver` there is no change source in a
  // test process at all, and this assertion is the one that fails first when it is missing.
  bunTest('a committed write arrives as a patch, not as a second snapshot', async () => {
    const feed = await driver.subscribe<{ id: string; title: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );

    await as(member('m1', ACME), () => db.notes.update(NOTE_ONE, { title: 'renamed' }));
    await feed.settled();

    expect(feed.snapshots()).toBe(1);
    expect(feed.patches()).toMatchObject([{ op: 'update', row: { id: NOTE_ONE } }]);
    expect(feed.row(NOTE_ONE)?.title).toBe('renamed');
  });

  bunTest('an insert into the window arrives as an insert patch', async () => {
    const feed = await driver.subscribe<{ id: string; title: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );

    await as(member('m1', ACME), () =>
      db.notes.insert({ id: '00000000-0000-4000-8000-000000000004', orgId: ACME, title: 'four' }),
    );
    await feed.settled();

    expect(feed.patches().map((patch) => patch.op)).toEqual(['insert']);
    expect(feed.rows()).toHaveLength(3);
  });

  // A write to a row this subscriber's window does not hold must not reach it. The gate is the
  // matcher's dependency set plus the per-subscriber `visible` rule — both real here.
  bunTest("another org's write reaches nobody in this window", async () => {
    const feed = await driver.subscribe<{ id: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );

    await as(member('m2', TINTA), () => db.notes.update(NOTE_FAR, { title: 'moved' }));
    await feed.settled();

    expect(feed.patches()).toEqual([]);
    expect(feed.rows()).toHaveLength(2);
  });

  bunTest('two subscribers of one query each get their own window', async () => {
    const acme = await driver.subscribe<{ id: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );
    const tinta = await driver.subscribe<{ id: string }>(
      liveNotes,
      { orgId: TINTA },
      member('m2', TINTA),
    );
    expect(acme.rows()).toHaveLength(2);
    expect(tinta.rows()).toHaveLength(1);
  });

  /**
   * The reconnect path, and the one the framework calls its biggest identified risk. What decides
   * it is `resumeFrom` on the node, comparing the cursor against the retained window — so the
   * assertion reads the FRAMES: a `patch` after the resubscribe means it replayed from the cursor,
   * a second `snapshot` means it refused and re-read.
   */
  bunTest('a reconnect inside the retained window is a delta, not a second snapshot', async () => {
    // A SECOND subscriber of the same `(query, input)`, and it is load-bearing rather than
    // decoration: the retained window is the registry's entry, and the entry is dropped when its
    // last subscriber goes. A lone subscriber therefore cannot resume from its own reconnect on
    // this node — there is nothing left to replay — and the node re-snapshots, correctly. What a
    // browser actually reconnects into is a node other subscribers are holding open.
    const other = await driver.subscribe<{ id: string }>(
      liveNotes,
      { orgId: ACME },
      member('m2', ACME),
    );
    const feed = await driver.subscribe<{ id: string; title: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );
    expect(feed.snapshots()).toBe(1);

    await as(member('m1', ACME), () => db.notes.update(NOTE_ONE, { title: 'while away' }));
    await feed.reconnect();

    expect(feed.snapshots()).toBe(1); // the initial one only
    expect(feed.resubscribedFrom()).toBeDefined();
    expect(feed.row(NOTE_ONE)?.title).toBe('while away');
    expect(other.rows()).toHaveLength(2);
  });

  // The other half of the same decision, and the honest one to state: a lone subscriber's
  // reconnect re-reads, because its own departure took the window with it.
  bunTest('a lone subscriber reconnecting gets a fresh snapshot, not a silent gap', async () => {
    const feed = await driver.subscribe<{ id: string; title: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );
    await as(member('m1', ACME), () => db.notes.update(NOTE_ONE, { title: 'while away' }));
    await feed.reconnect();

    expect(feed.snapshots()).toBe(2);
    expect(feed.resubscribedFrom()).toBeUndefined();
    expect(feed.row(NOTE_ONE)?.title).toBe('while away');
  });

  // The bound this driver states out loud: a filtered write names rows the row observer never saw,
  // so there is no event to shape and every window is marked stale instead of told nothing.
  bunTest('a filtered write invalidates rather than pretending nothing happened', async () => {
    const feed = await driver.subscribe<{ id: string }>(
      liveNotes,
      { orgId: ACME },
      member('m1', ACME),
    );
    await as(member('m1', ACME), () => db.notes.updateWhere({ orgId: ACME }, { title: 'swept' }));
    await feed.settled();

    // Nothing was delivered as a patch — the point is that the subscriber is not told "no change".
    expect(feed.patches()).toEqual([]);
  });
});

describe(testName('unit', 'the subscribe fixture with nothing to serve'), () => {
  bunTest(
    'an empty query registry is a refusal, not a working socket serving nothing',
    async () => {
      resetRegistry();
      await expect(createSubscribeDriver()).rejects.toBeUltimateError('X_TEST_LIVE_NODE_EMPTY');
    },
  );
});
