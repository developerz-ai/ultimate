// A read's declared `rateLimit:` on the live subscribe: charged once per NEW subscription, against
// the node's own clock and the socket's resolved address — never again for a reconnect that
// resumes a window it already held, a re-seat, or the re-auth retry inside one subscribe.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, ctxOf, frozenClock, userActor } from '@ultimat3/core';
import {
  from,
  type QueryPolicy,
  query,
  queryHash,
  registerQuery,
  resetQueries,
  t,
} from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import type { JsonValue, Row } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';

const ROWS: Row[] = [{ id: 'p1', orgId: 'o1' }];
const INPUT: JsonValue = { orgId: 'o1' };
const LIMIT = 2;
const WINDOW_MS = 60_000;

/** Admits everyone, anonymous included — the bucket is the only thing under test. */
const open: QueryPolicy = {
  kind: 'allow',
  label: 'feed:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

const ws: WsLike = {
  send: (data) => data.length,
  close() {},
  subscribe() {},
  unsubscribe() {},
  getBufferedAmount: () => 0,
};

let sockets = 0;
const socketFor = (actor: Actor | null, clientAddress: string | null = '10.0.0.1'): SyncSocket => {
  sockets += 1;
  return new SyncSocket({
    ws,
    id: `s-${String(sockets)}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor,
    clientAddress,
  });
};

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

/** A fresh name per test: the bucket store is process-wide and keyed by the read's name. */
let reads = 0;
const limited = (clock = frozenClock('2026-10-04T00:00:00.000Z'), limit = LIMIT) => {
  const name = `spendFeed-${crypto.randomUUID()}`;
  const target = registerQuery(
    name,
    query({
      input: t.object({ orgId: t.string }),
      policy: open,
      live: true,
      rateLimit: { limit, windowMs: WINDOW_MS },
      sql: ({ orgId }) =>
        from<Row>('posts', async () => {
          reads += 1;
          return ROWS;
        })
          .where({ orgId })
          .orderBy('id')
          .limit(50),
    }),
  );
  const definition = liveQueryDefinition(target, {
    ctx: ctxOf({ role: 'sync', buildId: 'b' }),
  });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer(), clock });
  return { name, definition, registry, clock };
};

const alice = (): Actor => userActor({ id: 'alice', orgId: 'o1' });

describe('the live subscribe charges once per new subscription', () => {
  beforeEach(() => resetQueries());

  test('a query limited to 2 refuses the third subscribe with X_RATE_LIMITED', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(
        await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
      );
    }
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });

  test('a re-authorization spends nothing: the subscription it holds was paid for', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const socket = socketFor(alice());
    expect(await outcome(registry.subscribe({ socket, name, input: INPUT }))).toBe('ok');
    for (let i = 0; i < 3; i += 1) expect(await registry.reauthorize(socket)).toEqual([]);
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('ok');
  });

  test('a reconnect that resumes the window it held is not charged again', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const first = await registry.subscribe({ socket: socketFor(alice()), name, input: INPUT });
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('ok');
    // A rolling deploy: every replica the client lands on sees the same cursor come back.
    for (let i = 0; i < 4; i += 1) {
      const resume = registry.subscribe({
        socket: socketFor(alice()),
        name,
        input: INPUT,
        cursor: first.subscription.cursor,
      });
      expect(await outcome(resume)).toBe('ok');
    }
    // A cold subscribe still pays, and the bucket is empty.
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('X_RATE_LIMITED');
  });

  // The qid is computable — `windowId(queryHash(name, input), tenant)`, and it rides every snapshot
  // cursor — so a cursor is a claim, never proof of a held window. Trusting it made every
  // subscribe+unsubscribe cycle a free database read.
  test('a forged cursor naming this window still pays for the read it causes', async () => {
    const { name, definition, registry } = limited(undefined, 1);
    registry.register(definition);
    const forged = {
      qid: JSON.stringify([queryHash(name, INPUT), 'o1']),
      lsn: '',
      ids: [],
      at: 0,
    };
    reads = 0;
    const seen: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const socket = socketFor(alice());
      const attempt = registry.subscribe({ socket, name, input: INPUT, cursor: forged });
      seen.push(await outcome(attempt));
      registry.unsubscribeSocket(socket.id);
    }
    expect(seen[0]).toBe('ok');
    expect(seen.slice(1).every((code) => code === 'X_RATE_LIMITED')).toBe(true);
    expect(reads).toBe(1);
  });

  test('a cursor naming another window is a cold start, and pays', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const forged = { qid: 'not-this-window', lsn: '', ids: [], at: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const socket = socketFor(alice());
      seen.push(await outcome(registry.subscribe({ socket, name, input: INPUT, cursor: forged })));
    }
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });

  test('the re-auth retry inside one subscribe charges once', async () => {
    const { name, definition, registry } = limited();
    let swapped = false;
    registry.register({
      ...definition,
      // An actor replaced while the subscribe is in flight: the registry serves it again under
      // the new one, and that second pass is the same subscribe, already paid for.
      authorize: async (args) => {
        await definition.authorize?.(args);
        if (swapped) return;
        swapped = true;
        socket.actor = userActor({ id: 'alice', orgId: 'o1', permissions: ['x'] });
      },
    });
    const socket = socketFor(alice());
    expect(await outcome(registry.subscribe({ socket, name, input: INPUT }))).toBe('ok');
    expect(swapped).toBe(true);
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('ok');
  });

  test('a re-seat onto a new tenant is not a new subscription', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const socket = socketFor(alice());
    expect(await outcome(registry.subscribe({ socket, name, input: INPUT }))).toBe('ok');
    socket.actor = userActor({ id: 'alice', orgId: 'o2' });
    await registry.reauthorize(socket);
    socket.actor = alice();
    await registry.reauthorize(socket);
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('ok');
  });

  test("the bucket refills on the node's clock, not the wall clock", async () => {
    const { name, definition, registry, clock } = limited();
    registry.register(definition);
    for (let i = 0; i < LIMIT; i += 1) {
      await registry.subscribe({ socket: socketFor(alice()), name, input: INPUT });
    }
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('X_RATE_LIMITED');
    clock.advance(WINDOW_MS);
    expect(
      await outcome(registry.subscribe({ socket: socketFor(alice()), name, input: INPUT })),
    ).toBe('ok');
  });

  test('two anonymous sockets from different addresses get separate buckets', async () => {
    const { name, definition, registry } = limited();
    registry.register(definition);
    const from = (address: string) =>
      outcome(registry.subscribe({ socket: socketFor(null, address), name, input: INPUT }));
    expect([
      await from('198.51.100.1'),
      await from('198.51.100.1'),
      await from('198.51.100.1'),
    ]).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
    // One visitor looping subscribes must not lock out every other anonymous viewer.
    expect(await from('203.0.113.9')).toBe('ok');
  });
});
