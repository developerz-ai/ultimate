import { beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, createContext, userActor } from '@ultimat3/core';
import { from, type QueryPolicy, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';
import type { RowDenied } from './subscriber-gate';
import { decode, type Frame } from './sync-protocol';

interface FeedRow extends Row {
  readonly orgId: string;
  readonly ownerId: string;
  readonly likes: number;
}

const ROWS: FeedRow[] = [
  { id: 'p1', orgId: 'o1', ownerId: 'alice', likes: 0 },
  { id: 'p2', orgId: 'o1', ownerId: 'bob', likes: 0 },
];

/**
 * Structural rather than built with `@ultimat3/policy`: realtime reaches that package only
 * through `@ultimat3/query`'s `guard`, and a test that imported it directly would be the second
 * authz path this package's boundary exists to forbid.
 *
 * The rule is row-level, which is the case the whole design turns on — two actors with identical
 * query arguments are entitled to different rows.
 */
const ownRowsOnly: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: ({ actor, row }) => {
    if (actor === null) return { allowed: false, reason: 'anonymous', code: 'X_UNAUTHENTICATED' };
    if (row === null) return { allowed: true };
    const owner = (row as FeedRow).ownerId;
    return owner === actor.id
      ? { allowed: true }
      : {
          allowed: false,
          reason: `${String(actor.id)} does not own ${owner}`,
          code: 'X_FORBIDDEN',
        };
  },
};

let reads = 0;
let visibleCalls = 0;
/** Compiled sources built for a `(query, input)` pair. Two of them is the bug this file pins. */
let builds = 0;

function declareFeed(policy: QueryPolicy = ownRowsOnly): ReturnType<typeof registerQuery> {
  const target = query({
    input: t.object({ orgId: t.string }),
    policy,
    live: true,
    sql: ({ orgId }) =>
      from<FeedRow>('posts', async () => {
        reads += 1;
        return ROWS;
      })
        .where({ orgId })
        .orderBy('id')
        .limit(50),
  });
  return registerQuery('liveFeed', target);
}

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

function socketFor(id: string, actor: Actor | null): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    ...(actor === null ? {} : { actor }),
  });
  return { socket, ws };
}

const INPUT: JsonValue = { orgId: 'o1' };

/** The node's own context: services and a clock, and deliberately nobody's authority. */
const nodeCtx = (): ReturnType<typeof createContext> =>
  createContext({ role: 'sync', buildId: 'build-1' });

function registryFor(
  policy: QueryPolicy = ownRowsOnly,
  denied?: (event: RowDenied) => void,
): LiveQueryRegistry {
  const target = declareFeed(policy);
  const registry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    ...(denied ? { onRowDenied: denied } : {}),
  });
  // `visible` is counted through a wrapper so the test can assert the *number* of decisions,
  // which is the only way to catch a memo that silently answers for the wrong actor.
  const definition = liveQueryDefinition(target, { ctx: nodeCtx() });
  return registry.register({
    ...definition,
    visible: async (args) => {
      visibleCalls += 1;
      return await definition.visible(args);
    },
  });
}

function change(after: FeedRow, before: FeedRow | null): ChangeEvent {
  return {
    entity: 'posts',
    op: 'update',
    before,
    after,
    lsn: formatLsn(2),
    txid: '2',
    orgId: 'o1',
    at: 1_000,
  };
}

/**
 * A declaration whose every build is *distinguishable*: the rows it serves carry the number of the
 * build that produced them. A second build of one `(query, input)` therefore cannot hide behind
 * two sources that happen to agree — it shows up in the snapshot as rows the matcher never saw.
 */
function declareDrifting(): ReturnType<typeof registerQuery> {
  return registerQuery(
    'driftFeed',
    query({
      input: t.object({ orgId: t.string }),
      policy: ownRowsOnly,
      live: true,
      sql: ({ orgId }) => {
        builds += 1;
        const build = builds;
        return from<FeedRow>('posts', async () => {
          reads += 1;
          return [{ id: `p${build}`, orgId, ownerId: 'alice', likes: build }];
        })
          .where({ orgId })
          .orderBy('id')
          .limit(50);
      },
    }),
  );
}

describe('a declared live query is subscribable, per subscriber', () => {
  beforeEach(() => {
    resetRegistry();
    reads = 0;
    visibleCalls = 0;
    builds = 0;
  });

  test('two actors on one query id share the shape and get different rows', async () => {
    const registry = registryFor();
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));
    const bob = socketFor('s-bob', userActor({ id: 'bob', orgId: 'o1' }));

    const first = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input: INPUT,
    });
    const second = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input: INPUT });

    if (first.frame.type !== 'snapshot' || second.frame.type !== 'snapshot') {
      throw new Error('expected two snapshots');
    }
    expect(first.frame.rows.map((row) => row.id)).toEqual(['p1']);
    expect(second.frame.rows.map((row) => row.id)).toEqual(['p2']);
    expect(first.subscription.qid).toBe(second.subscription.qid);
    // One query id, one compiled source and one matcher — and two full policy passes, one per
    // subscriber over every row. A memo keyed by anything they share would show up here as a
    // count below `rows × subscribers`, with the second actor reading the first one's answer.
    expect(visibleCalls).toBe(ROWS.length * 2);
    // The window itself is re-read at each subscribe: a client joining later must see the rows as
    // they are now, not as they were when someone else joined.
    expect(reads).toBe(2);
  });

  test('the shared window is built with no subject, so a denial is still per subscriber', async () => {
    const registry = registryFor();
    const nobody = socketFor('s-anon', null);

    // The node context that built the window is anonymous, and this policy denies anonymous —
    // yet the window exists, because building it decided about nobody. The subscriber is what
    // gets refused, at its own subscribe.
    await expect(
      registry.subscribe({ socket: nobody.socket, name: 'liveFeed', input: INPUT }),
    ).rejects.toBeUltimateError('X_UNAUTHENTICATED');

    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));
    const allowed = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input: INPUT,
    });
    expect(allowed.frame.type).toBe('snapshot');
  });

  test('a patch reaches only the subscriber whose policy admits the row', async () => {
    const registry = registryFor();
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));
    const bob = socketFor('s-bob', userActor({ id: 'bob', orgId: 'o1' }));
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input: INPUT });
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input: INPUT });
    alice.ws.frames.length = 0;
    bob.ws.frames.length = 0;

    // The change is matched once for the query id — the pre-filter has to admit it, which it can
    // only do from the entity the resolved matcher reports.
    const sent = await registry.deliver(
      change({ ...(ROWS[1] as FeedRow), likes: 1 }, ROWS[1] ?? null),
    );

    expect(sent).toBe(1);
    // Alice is not entitled to p2 and does not hold it, so there is nothing to say to her.
    expect(alice.ws.frames).toHaveLength(0);
    const frame = bob.ws.frames[0];
    if (frame?.type !== 'patch') throw new Error('expected a patch frame for bob');
    // The content is the assertion that matters: a gate deciding from anything other than *this*
    // subscriber would deny bob his own row and turn the update into a delete he never earned.
    expect(frame.patches[0]).toMatchObject({ op: 'update', id: 'p2', row: { likes: 1 } });
    expect(bob.ws.frames).toHaveLength(1);
  });

  test('every delivered row is re-checked, and a lost grant arrives as a delete', async () => {
    const events: RowDenied[] = [];
    const registry = registryFor(ownRowsOnly, (event) => events.push(event));
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));
    const bob = socketFor('s-bob', userActor({ id: 'bob', orgId: 'o1' }));
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input: INPUT });
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input: INPUT });
    alice.ws.frames.length = 0;
    bob.ws.frames.length = 0;
    events.length = 0;

    // p1 changes hands. Nothing about the query id changed — only who is entitled to the row.
    const owned = ROWS[0] as FeedRow;
    await registry.deliver(change({ ...owned, ownerId: 'carol' }, owned));

    const frame = alice.ws.frames[0];
    if (frame?.type !== 'patch') throw new Error('expected a patch frame for alice');
    expect(frame.patches[0]).toMatchObject({ op: 'delete', id: 'p1' });
    // Bob never held it, so for him it is a drop rather than a delete — and neither of them is
    // told anything about the other's entitlement.
    expect(bob.ws.frames).toHaveLength(0);
    expect(events.map((event) => event.actorId).sort()).toEqual(['alice', 'bob']);
  });

  test('the compiled-source cache is bounded, and an evicted input still subscribes', async () => {
    const target = declareFeed();
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      liveQueryDefinition(target, { ctx: nodeCtx(), maxWindows: 1 }),
    );
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    // The key is an argument the client chooses, so the map that holds compiled sources has to
    // have a ceiling. Crossing it costs a rebuild and nothing else.
    for (const orgId of ['o1', 'o2', 'o1']) {
      const result = await registry.subscribe({
        socket: alice.socket,
        name: 'liveFeed',
        input: { orgId },
      });
      expect(result.frame.type).toBe('snapshot');
    }
    expect(reads).toBe(3);
  });

  test('one build per (query, input): the window reads the source the matcher describes', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      liveQueryDefinition(declareDrifting(), { ctx: nodeCtx() }),
    );
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    const first = await registry.subscribe({
      socket: alice.socket,
      name: 'driftFeed',
      input: INPUT,
    });

    // Two builds is not merely wasted work — the second one is what the subscriber is *served*
    // while the matcher patching them belongs to the first, so the rows say `p2` and every patch
    // is computed against a window that never held them.
    expect(builds).toBe(1);
    if (first.frame.type !== 'snapshot') throw new Error('expected a snapshot');
    expect(first.frame.rows.map((row) => row.id)).toEqual(['p1']);
  });

  test('a second subscriber re-reads that one source rather than compiling another', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      liveQueryDefinition(declareDrifting(), { ctx: nodeCtx() }),
    );
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));
    await registry.subscribe({ socket: alice.socket, name: 'driftFeed', input: INPUT });

    const second = await registry.subscribe({
      socket: socketFor('s-second', userActor({ id: 'alice', orgId: 'o1' })).socket,
      name: 'driftFeed',
      input: INPUT,
    });

    // The window is shared and re-read; the compile is not repeated. One build, two reads.
    expect(builds).toBe(1);
    expect(reads).toBe(2);
    if (second.frame.type !== 'snapshot') throw new Error('expected a snapshot');
    expect(second.frame.rows.map((row) => row.id)).toEqual(['p1']);
    // A different input is a different query id, and that one does compile — the dedup is per
    // `(query, input)`, never a single source stretched over every argument a client sends.
    await registry.subscribe({
      socket: alice.socket,
      name: 'driftFeed',
      input: { orgId: 'o2' },
    });
    expect(builds).toBe(2);
  });

  test('a projection with no id is refused, not delivered as a row nobody can patch', async () => {
    const target = registerQuery(
      'slugFeed',
      query({
        input: t.object({ orgId: t.string }),
        policy: ownRowsOnly,
        live: true,
        sql: () =>
          from<{ slug: string }>('posts', [{ slug: 'hello' }])
            .orderBy('slug')
            .limit(10),
      }),
    );
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      liveQueryDefinition(target, { ctx: nodeCtx() }),
    );
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    await expect(
      registry.subscribe({ socket: alice.socket, name: 'slugFeed', input: INPUT }),
    ).rejects.toBeUltimateError('X_LIVE_ROW_UNIDENTIFIED');
  });

  test('a withheld row is a metric, never a frame and never an error', async () => {
    const events: RowDenied[] = [];
    const registry = registryFor(ownRowsOnly, (event) => events.push(event));
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    const result = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input: INPUT,
    });

    if (result.frame.type !== 'snapshot') throw new Error('expected a snapshot');
    expect(result.frame.rows.map((row) => row.id)).toEqual(['p1']);
    expect(registry.rowsDenied).toBe(1);
    expect(events).toEqual([
      { qid: result.subscription.qid, sid: result.subscription.sid, actorId: 'alice', rowId: 'p2' },
    ]);
  });
  /**
   * The identity scope, end to end from a real declaration — the half a browser cannot derive for
   * itself, because the shape is compiled server-side out of `sql`. It is the SAME name a
   * `ChangeEvent` carries and a mutator's `tx.<table>` writes, which is what lets one client hold
   * one row for a live query and an optimistic write alike.
   */
  test("a snapshot names the entity its rows belong to, and it is the change feed's name", async () => {
    const registry = registryFor();
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    const result = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input: INPUT,
    });

    if (result.frame.type !== 'snapshot') throw new Error('expected a snapshot');
    expect(result.frame.entity).toBe('posts');
    expect(result.frame.entity).toBe(change(ROWS[0] as FeedRow, null).entity);
  });

  test('a definition that states no entity sends no scope, rather than guessing one', async () => {
    const target = declareFeed();
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    const { rowEntity: _dropped, ...silent } = liveQueryDefinition(target, { ctx: nodeCtx() });
    registry.register(silent);
    const alice = socketFor('s-alice', userActor({ id: 'alice', orgId: 'o1' }));

    const result = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input: INPUT,
    });

    if (result.frame.type !== 'snapshot') throw new Error('expected a snapshot');
    expect(result.frame.entity).toBeUndefined();
  });
});
