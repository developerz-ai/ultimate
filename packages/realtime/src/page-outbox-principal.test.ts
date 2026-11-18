// A queued write belongs to the principal whose queue holds it. The fake server below is the
// action pipeline's rule in miniature, keyed by a cookie only the test moves: what a SECOND TAB
// does to this one, which sees no `rescope` and whose page still says the old principal.

import { afterEach, describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { CLIENT_REPLAY_SCOPE_HEADER, rescope } from '@ultimat3/core';
import { type LocalStore, memoryLocalStore } from './local-store-idb';
import type { QueuedMutation } from './offline-queue';
import type { OutboxEntry, OutboxOverlays } from './page-outbox';
import { localOutbox } from './page-outbox';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));
});

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });

const problem = (status: number, code: string): Response =>
  new Response(JSON.stringify({ code, cause: 'refused by the test server', fix: 'x doctor' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Ran {
  readonly key: string;
  readonly as: string | null;
}

/** The server: `cookie` is the session, `null` none; a write it accepts is recorded as run. */
function server(cookie: string | null) {
  const state = {
    cookie,
    ran: [] as Ran[],
    named: [] as (string | null)[],
    /** Parks the request for this key until `release()`: the moment another tab acts. */
    parkOn: undefined as string | undefined,
    parked: undefined as Promise<void> | undefined,
    release: (): void => undefined,
    reached: (): void => undefined,
  };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const key = headers.get('idempotency-key') ?? '';
    const named = headers.get(CLIENT_REPLAY_SCOPE_HEADER);
    state.named.push(named);
    const session = state.cookie === null ? 'anon' : `p:${state.cookie}`;
    if (named !== null && named !== session) return problem(409, 'X_REPLAY_PRINCIPAL_MISMATCH');
    state.ran.push({ key, as: state.cookie });
    if (key === state.parkOn) {
      state.reached();
      await state.parked;
    }
    return Response.json({});
  }) as typeof fetch;
  return state;
}

function parkOn(state: ReturnType<typeof server>, key: string): Promise<void> {
  state.parkOn = key;
  state.parked = new Promise((resolve) => {
    state.release = resolve;
  });
  return new Promise((resolve) => {
    state.reached = resolve;
  });
}

function overlays(): OutboxOverlays & { readonly dropped: string[] } {
  const dropped: string[] = [];
  return { dropped, settle: () => undefined, drop: (key) => dropped.push(key) };
}

const onDisk = async (local: LocalStore, scope: string) =>
  ((await local.queue(scope))?.mutations ?? []).map(({ key, status }) => ({ key, status }));

/** Exactly what a build older than the binding left in IndexedDB: nothing here names anyone. */
const stored = (key: string): QueuedMutation => ({
  key,
  seq: 1,
  name: 'likePost',
  input: {},
  enqueuedAt: 0,
  attempts: 0,
  status: 'pending',
  error: null,
});

describe('a replay names the principal that queued it', () => {
  test('a signed-in queue names its scope', async () => {
    rescope('u1');
    const remote = server('u1');
    const outbox = localOutbox({ local: memoryLocalStore(), overlays: () => undefined });
    await outbox.enqueue(like(1));
    await outbox.replay();
    expect(remote.named).toEqual(['p:u1']);
  });

  test('an anonymous queue names `anon`, never a blank a proxy could drop', async () => {
    const remote = server(null);
    const outbox = localOutbox({
      local: memoryLocalStore(),
      principal: () => null,
      overlays: () => undefined,
    });
    await outbox.enqueue(like(1));
    await outbox.replay();
    expect(remote.named).toEqual(['anon']);
  });

  test('an unscoped page knows no principal and claims none', async () => {
    const remote = server('u1');
    const outbox = localOutbox({
      local: memoryLocalStore(),
      principal: () => undefined,
      overlays: () => undefined,
    });
    await outbox.enqueue(like(1));
    await outbox.replay();
    expect(remote.named).toEqual([null]);
  });
});

describe('another tab changes the session under a replay', () => {
  test('the entry behind the one on the wire is refused, kept, and sent once its owner is back', async () => {
    rescope('u1');
    const local = memoryLocalStore();
    const remote = server('u1');
    const held = overlays();
    const warned: UltimateError[] = [];
    const outbox = localOutbox({
      local,
      overlays: () => held,
      warn: (error) => warned.push(error),
    });
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    const onTheWire = parkOn(remote, 'like:1');
    const pass = outbox.replay();
    await onTheWire;

    // The second tab: only the cookie moves. This page hears nothing and keeps saying u1.
    remote.cookie = 'u2';
    remote.release();
    const report = await pass;

    expect(remote.ran).toEqual([{ key: 'like:1', as: 'u1' }]);
    expect(report.stoppedAt).toBe('like:2');
    expect(await onDisk(local, 'p:u1')).toEqual([{ key: 'like:2', status: 'pending' }]);
    expect(outbox.pending().map((entry) => entry.key)).toEqual(['like:2']);
    expect(held.dropped).toEqual([]);
    expect(warned.map((error) => error.code)).toEqual(['X_REPLAY_PRINCIPAL_MISMATCH']);

    // Still u2: asked again, still refused, and nothing ran as u2.
    await outbox.replay();
    expect(remote.ran.filter((run) => run.as === 'u2')).toEqual([]);

    remote.cookie = 'u1';
    await outbox.replay();
    expect(remote.ran).toEqual([
      { key: 'like:1', as: 'u1' },
      { key: 'like:2', as: 'u1' },
    ]);
    expect(await onDisk(local, 'p:u1')).toEqual([]);
  });

  test('a signed-out session keeps a signed-in queue for its owner, in order', async () => {
    rescope('u1');
    const local = memoryLocalStore();
    const remote = server('u1');
    const refusing = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) =>
      remote.cookie === null
        ? Promise.resolve(problem(401, 'X_UNAUTHENTICATED'))
        : refusing(url, init)) as typeof fetch;
    const held = overlays();
    const outbox = localOutbox({ local, overlays: () => held, warn: () => undefined });
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    remote.cookie = null;

    const report = await outbox.replay();

    expect(report.stoppedAt).toBe('like:1');
    expect(await onDisk(local, 'p:u1')).toEqual([
      { key: 'like:1', status: 'pending' },
      { key: 'like:2', status: 'pending' },
    ]);
    expect(held.dropped).toEqual([]);

    remote.cookie = 'u1';
    await outbox.replay();
    expect(remote.ran.map((run) => run.key)).toEqual(['like:1', 'like:2']);
  });

  test("an anonymous queue's 401 is still the server's answer about the write", async () => {
    const local = memoryLocalStore();
    server(null);
    globalThis.fetch = (() => Promise.resolve(problem(401, 'X_UNAUTHENTICATED'))) as never;
    const held = overlays();
    const outbox = localOutbox({ local, principal: () => null, overlays: () => held });
    await outbox.enqueue(like(1));

    await outbox.replay();

    expect(await onDisk(local, 'anon')).toEqual([{ key: 'like:1', status: 'failed' }]);
    expect(held.dropped).toEqual(['like:1']);
  });
});

describe('an entry stored by a build older than the binding', () => {
  const legacy = async (): Promise<LocalStore> => {
    const local = memoryLocalStore();
    await local.writeQueue('p:u1', { puts: [stored('old')], deletes: [], nextSeq: 2 });
    return local;
  };

  test('is bound by the queue that holds it: refused under another session, not lost, no throw', async () => {
    rescope('u1');
    const local = await legacy();
    const remote = server('u2');
    const outbox = localOutbox({ local, overlays: () => undefined, warn: () => undefined });

    const report = await outbox.replay();

    expect(remote.named).toEqual(['p:u1']);
    expect(remote.ran).toEqual([]);
    expect(report.stoppedAt).toBe('old');
    expect(await onDisk(local, 'p:u1')).toEqual([{ key: 'old', status: 'pending' }]);
  });

  test('is delivered to its owner, so an upgrade does not cost a queued write', async () => {
    rescope('u1');
    const local = await legacy();
    const remote = server('u1');
    const outbox = localOutbox({ local, overlays: () => undefined });

    await outbox.replay();

    expect(remote.ran).toEqual([{ key: 'old', as: 'u1' }]);
    expect(await onDisk(local, 'p:u1')).toEqual([]);
  });
});
