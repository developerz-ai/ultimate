// A live query's source is read FOR A TENANT: the shared window is keyed by the subscriber's org
// and read under a context that carries it, so a repo that leaves the tenant to the acting actor —
// what `x g query --live` generates — reads on a sync node exactly as it does over HTTP, and two
// subscribers of one `(query, input)` in two orgs never share a row.
//
// Driven through the registry a sync node routes `subscribe` frames into and the in-process
// replicator `x dev` runs on — never `.as(actor)`, which installs a context of its own and is why
// the generated suite passed while every real subscriber got `X_TENANCY_UNSCOPED`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, createContext, runWithContext, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  setRowObserver,
  text,
  uuid,
} from '@ultimat3/entity';
import { from, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { type LiveReplicator, startLiveReplicator } from './live-replicator';
import { OPEN_POLICY } from './policy-fake-fixture';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';

const notes = entity('tenant_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
type Note = typeof notes.$row;

const driver = memoryDriver();
const db = database({ notes }, { driver });

/** What `x g query --live` emits: the repo names NO org — the acting actor's scopes the plan. */
const list = (limit: number): Promise<readonly Note[]> => db.notes.orderBy('id').limit(limit).all();

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

const socketFor = (id: string, actor: Actor | null): { socket: SyncSocket; ws: FakeWs } => {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'b',
    serverBuildId: 'b',
    ...(actor === null ? {} : { actor }),
  });
  return { socket, ws };
};

const member = (id: string, orgId: string): Actor => userActor({ id, orgId });

const asMember = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: member('writer', orgId) }), run);

const insert = (id: number, orgId: string, label: string): Promise<Note> =>
  asMember(orgId, () =>
    db.notes.insert({
      id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      orgId,
      label,
    }),
  );

const labels = (frame: Frame | undefined): readonly unknown[] =>
  frame?.type === 'snapshot' ? frame.rows.map((row) => row['label']) : [];

/**
 * The strongest form: nothing in the input or the shape names a tenant at all, so the window's key
 * and its read context are the ONLY things keeping two orgs apart.
 */
const unnamedNotes = () =>
  query({
    input: t.object({ limit: t.number.default(50) }),
    policy: OPEN_POLICY,
    live: true,
    sql: ({ limit }) =>
      from<Note>('tenant_notes', () => list(limit))
        .orderBy('id')
        .limit(limit),
  });

let registry: LiveQueryRegistry;
let replicator: LiveReplicator;

beforeEach(async () => {
  resetRegistry();
  driver.reset?.();
  // The generated shape: an `orgId` in the input the policy decides on, a repo that names none.
  const generated = query({
    input: t.object({ orgId: t.uuid, limit: t.number.default(50) }),
    policy: OPEN_POLICY,
    live: true,
    sql: ({ orgId, limit }) =>
      from<Note>('tenant_notes', () => list(limit))
        .where({ orgId })
        .orderBy('id')
        .limit(limit),
  });
  registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
  const ctx = createContext({ role: 'sync', buildId: 'b' });
  registry.register(liveQueryDefinition(registerQuery('liveNotes', generated), { ctx }));
  registry.register(liveQueryDefinition(registerQuery('liveAllNotes', unnamedNotes()), { ctx }));
  replicator = await startLiveReplicator({ registry });
});

afterEach(() => {
  replicator.stop();
  setRowObserver(null);
});

afterAll(() => {
  clearRegistry();
  resetRegistry();
});

describe('a live source is read for the subscriber’s tenant', () => {
  test('the generated shape reads on a sync node: the repo names no org', async () => {
    await insert(1, ACME, 'acme-1');
    await insert(2, GLOBEX, 'globex-1');
    const ada = socketFor('s-ada', member('ada', ACME));

    const { frame } = await registry.subscribe({
      socket: ada.socket,
      name: 'liveNotes',
      input: { orgId: ACME },
    });

    expect(labels(frame)).toEqual(['acme-1']);
  });

  test('two orgs on one (query, input) never see each other’s rows — snapshot or patch', async () => {
    await insert(1, ACME, 'acme-1');
    await insert(2, GLOBEX, 'globex-1');
    const ada = socketFor('s-ada', member('ada', ACME));
    const gus = socketFor('s-gus', member('gus', GLOBEX));

    // The SAME query and the SAME input: one query id, which was one shared window.
    const first = await registry.subscribe({ socket: ada.socket, name: 'liveAllNotes', input: {} });
    const second = await registry.subscribe({
      socket: gus.socket,
      name: 'liveAllNotes',
      input: {},
    });
    expect(labels(first.frame)).toEqual(['acme-1']);
    expect(labels(second.frame)).toEqual(['globex-1']);
    expect(first.subscription.qid).not.toBe(second.subscription.qid);

    await insert(3, ACME, 'acme-2');
    await replicator.settled();

    const patched = (ws: FakeWs): readonly unknown[] =>
      ws.frames.flatMap((sent) =>
        sent.type === 'patch' ? sent.patches.map((patch) => patch.row?.['label']) : [],
      );
    expect(patched(ada.ws)).toEqual(['acme-2']);
    // Nothing at all: not the row, and not a frame that says a row exists.
    expect(gus.ws.frames).toEqual([]);
  });

  test('a second subscriber of the same org joins the window instead of reading again', async () => {
    await insert(1, ACME, 'acme-1');
    const ada = socketFor('s-ada', member('ada', ACME));
    const ali = socketFor('s-ali', member('ali', ACME));
    const first = await registry.subscribe({ socket: ada.socket, name: 'liveAllNotes', input: {} });
    const second = await registry.subscribe({
      socket: ali.socket,
      name: 'liveAllNotes',
      input: {},
    });
    expect(second.subscription.qid).toBe(first.subscription.qid);
    expect(registry.subscriberCount(first.subscription.qid)).toBe(2);
  });

  test('a subscriber with no org is refused a tenant table by name, as over HTTP', async () => {
    await insert(1, ACME, 'acme-1');
    const nobody = socketFor('s-anon', null);
    const refused = await registry
      .subscribe({ socket: nobody.socket, name: 'liveAllNotes', input: {} })
      .catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('X_TENANCY_ACTOR_ORG_REQUIRED');
  });

  test('a cursor minted for another tenant’s window is a cold start, never a replay', async () => {
    await insert(1, ACME, 'acme-1');
    await insert(2, GLOBEX, 'globex-1');
    const ada = socketFor('s-ada', member('ada', ACME));
    const first = await registry.subscribe({ socket: ada.socket, name: 'liveAllNotes', input: {} });
    // Held BEFORE the change, so the change below is a patch retained past this cursor — in
    // acme's ring, which is exactly what a resume under it would replay.
    const held = first.subscription.cursor;
    await insert(3, ACME, 'acme-2');
    await replicator.settled();

    // The same client, signed in to another org, resuming with the cursor it still holds.
    const gus = socketFor('s-gus', member('gus', GLOBEX));
    const resumed = await registry.subscribe({
      socket: gus.socket,
      name: 'liveAllNotes',
      input: {},
      cursor: held,
    });
    expect(resumed.frame.type).toBe('snapshot');
    expect(labels(resumed.frame)).toEqual(['globex-1']);
  });

  test('an actor that moves org mid-connection is re-seated on its new tenant’s window', async () => {
    await insert(1, ACME, 'acme-1');
    await insert(2, GLOBEX, 'globex-1');
    const ada = socketFor('s-ada', member('ada', ACME));
    const first = await registry.subscribe({
      socket: ada.socket,
      name: 'liveAllNotes',
      input: {},
      sid: 'sub-1',
    });
    ada.socket.actor = member('ada', GLOBEX);

    expect(await registry.reauthorize(ada.socket)).toEqual([]);

    const seated = registry.subscription('s-ada', 'sub-1');
    expect(seated?.qid).not.toBe(first.subscription.qid);
    expect(registry.subscriberCount(first.subscription.qid)).toBe(0);
    expect(labels(ada.ws.frames.at(-1))).toEqual(['globex-1']);
  });
});

/** Stands in for a policy store's timeout: a FOREIGN error, so it extends `Error` on purpose. */
class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

describe('a re-seat that cannot complete is refused to the client, never lost', () => {
  /** `liveAllNotes`, with an `authorize` that answers from a script — then the real one. */
  const flaky = (script: ('ok' | 'fail')[]): { calls: () => number } => {
    let calls = 0;
    const base = liveQueryDefinition(registerQuery('liveFlakyNotes', unnamedNotes()), {
      ctx: createContext({ role: 'sync', buildId: 'b' }),
    });
    registry.register({
      ...base,
      async authorize(args) {
        calls += 1;
        if (script.shift() === 'fail') throw new PoolTimeout('the policy store timed out');
        await base.authorize?.(args);
      },
    });
    return { calls: () => calls };
  };

  const refusals = (ws: FakeWs): readonly { ref: string; code: string | undefined }[] =>
    ws.frames.flatMap((sent) =>
      sent.type === 'ack' ? [{ ref: sent.ref, code: sent.error?.code }] : [],
    );

  test('an authorize that fails while the org moved: no second try, no stale window, a refusal', async () => {
    await insert(1, ACME, 'acme-1');
    const gate = flaky(['ok', 'fail', 'fail']);
    const ada = socketFor('s-ada', member('ada', ACME));
    const first = await registry.subscribe({
      socket: ada.socket,
      name: 'liveFlakyNotes',
      input: {},
      sid: 'sub-1',
    });
    ada.socket.actor = member('ada', GLOBEX);
    const failuresBefore = registry.gateFailures;

    // Not a denial, so not reported as one.
    expect(await registry.reauthorize(ada.socket)).toEqual([]);

    // One decision asked, one failure counted — the re-seat does not ask the store again.
    expect(gate.calls()).toBe(2);
    expect(registry.gateFailures - failuresBefore).toBe(1);
    // Off acme's window: an actor that left the org is never served from it.
    expect(registry.subscriberCount(first.subscription.qid)).toBe(0);
    expect(registry.subscription('s-ada', 'sub-1')).toBeUndefined();
    // And the client is told, in the words a refused subscribe uses, so the window renders failed.
    expect(refusals(ada.ws)).toEqual([{ ref: 'sub-1', code: 'X_DB_TIMEOUT' }]);
  });

  test('a re-seat whose subscribe fails sends the refusal for that sid', async () => {
    await insert(1, ACME, 'acme-1');
    flaky(['ok', 'ok', 'fail']);
    const ada = socketFor('s-ada', member('ada', ACME));
    await registry.subscribe({
      socket: ada.socket,
      name: 'liveFlakyNotes',
      input: {},
      sid: 'sub-1',
    });
    ada.socket.actor = member('ada', GLOBEX);

    expect(await registry.reauthorize(ada.socket)).toEqual([]);

    expect(registry.subscription('s-ada', 'sub-1')).toBeUndefined();
    expect(refusals(ada.ws)).toEqual([{ ref: 'sub-1', code: 'X_DB_TIMEOUT' }]);
  });

  test('an authorize that fails with the org unchanged keeps the subscription, desynced', async () => {
    await insert(1, ACME, 'acme-1');
    flaky(['ok', 'fail']);
    const ada = socketFor('s-ada', member('ada', ACME));
    await registry.subscribe({
      socket: ada.socket,
      name: 'liveFlakyNotes',
      input: {},
      sid: 'sub-1',
    });

    expect(await registry.reauthorize(ada.socket)).toEqual([]);

    expect(registry.subscription('s-ada', 'sub-1')).toBeDefined();
    expect(ada.socket.desynced.has('sub-1')).toBe(true);
    expect(refusals(ada.ws)).toEqual([]);
  });
});
