// What a channel seat owes when the ground moves under it: a re-ask on a suspended seat that is
// DENIED is refused, a guard still awaiting when the actor changes is decided again under the
// current one, the latch of denials is bounded, a missed change reopens every records topic, and
// a row the change could not carry whole is a gap rather than a partial record.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { ChannelHub, MAX_CHANNEL_PARAM_LENGTH, type Topic } from './channel';
import { channel } from './channel-decl';
import { updatesFor } from './channel-records';
import { clearChannels } from './channel-registry';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

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

class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

const notes = entity('channel_settle_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text(), body: text() },
});

let decide: (who: Actor | null) => boolean = () => true;
let loading: Promise<void> | null = null;
beforeEach(() => {
  decide = () => true;
  loading = null;
});
afterAll(() => {
  clearRegistry();
  clearChannels();
});

const policy = {
  kind: 'allow' as const,
  label: 'settle-guard',
  permissions: [],
  children: [],
  run: ({ actor }: { actor: Actor | null }) =>
    decide(actor)
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: 'denied', code: 'X_FORBIDDEN' } as const),
};

const feed = channel('settle-feed', {
  params: ['orgId'],
  catchUp: { name: 'settleRead' },
  policy,
  records: [notes],
  // The membership read a guard awaits: parked by the test, so a re-auth can land under it.
  row: async () => {
    await loading;
    return {};
  },
});
const everyone = channel('settle-all', {
  params: [],
  catchUp: { name: 'settleAll' },
  policy,
  records: [notes],
});

const alice = userActor({ id: 'alice', orgId: 'o1' });
const demoted = userActor({ id: 'alice-demoted', orgId: 'o1' });

function rig(options: { maxTopicsPerSocket?: number } = {}) {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: new InProcessTransport(), sockets, ...options });
  const ws = new FakeWs();
  const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor: alice });
  sockets.add(socket);
  const join = (orgId = 'o1', since?: { epoch: string; seq: number }): Promise<Topic> =>
    hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: 'settle-feed',
      params: { orgId },
      ...(since === undefined ? {} : { since }),
    });
  return { hub, socket, ws, join };
}

const suspend = async (hub: ChannelHub, socket: SyncSocket): Promise<void> => {
  decide = () => {
    throw new PoolTimeout('pool exhausted');
  };
  await hub.onActorChange(socket, alice);
};

describe('a re-ask on a suspended seat', () => {
  test('that is DENIED is refused, dropped and latched — never answered as a success', async () => {
    const { hub, socket, join } = rig();
    const name = await join();
    await suspend(hub, socket);
    decide = () => false;

    await expect(join()).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');

    expect(hub.topicsOf(socket)).toEqual([]);
    expect(hub.topicCount).toBe(0);
    // Latched: the next ask is answered without the policy running again.
    let asked = 0;
    decide = () => {
      asked += 1;
      return true;
    };
    await expect(join()).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');
    expect(asked).toBe(0);
    expect(name).toBe(feed.topic({ orgId: 'o1' }));
  });
});

describe('a guard still awaiting when the actor changes', () => {
  const parked = (): { release: () => void } => {
    let release!: () => void;
    loading = new Promise<void>((settle) => {
      release = settle;
    });
    return { release };
  };

  test('a subscribe is decided again under the CURRENT actor before it is seated', async () => {
    const { hub, socket, join } = rig();
    decide = (who) => who?.id === 'alice';
    const gate = parked();
    const pending = join();
    // The grant is reduced while the membership read is in flight. Nothing is seated yet, so the
    // re-auth has no seat to re-decide.
    await expect(hub.onActorChange(socket, demoted)).resolves.toEqual([]);
    gate.release();

    await expect(pending).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');
    expect(hub.topicsOf(socket)).toEqual([]);
    expect(hub.topicCount).toBe(0);
  });

  test('a beat on a suspended seat is decided for the actor on the socket when it resolves', async () => {
    const { hub, socket, join } = rig();
    await join();
    await suspend(hub, socket);
    decide = (who) => who?.id === 'alice';
    const gate = parked();
    const pending = join();
    // The re-auth pass re-decides the suspended seat too, parked on the same read.
    const reauth = hub.onActorChange(socket, demoted);
    gate.release();

    await expect(pending).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');
    await reauth;
    expect(hub.topicsOf(socket)).toEqual([]);
  });

  test('an actor that did not change is decided once', async () => {
    const { join } = rig();
    let asked = 0;
    decide = () => {
      asked += 1;
      return true;
    };
    await join();
    expect(asked).toBe(1);
  });
});

describe('the latch of denials is bounded', () => {
  test('past maxTopicsPerSocket the next ask is refused before any policy runs', async () => {
    const { hub, socket, join } = rig({ maxTopicsPerSocket: 3 });
    let asked = 0;
    decide = () => {
      asked += 1;
      return false;
    };
    for (const org of ['a', 'b', 'c']) {
      await expect(join(org)).rejects.toBeUltimateError('X_TOPIC_FORBIDDEN');
    }
    expect(asked).toBe(3);

    await expect(join('d')).rejects.toBeUltimateError('X_SUBSCRIPTION_LIMIT');
    expect(asked).toBe(3);
    // A new session re-decides everything.
    decide = () => true;
    await hub.onActorChange(socket, alice);
    await expect(join('d')).resolves.toBe(feed.topic({ orgId: 'd' }));
  });

  test('a param value past its ceiling is refused; one at it is a topic', async () => {
    const { join } = rig();
    await expect(join('x'.repeat(MAX_CHANNEL_PARAM_LENGTH + 1))).rejects.toBeUltimateError(
      'X_TOPIC_FORBIDDEN',
    );
    await expect(join('x'.repeat(MAX_CHANNEL_PARAM_LENGTH))).resolves.toBeDefined();
  });
});

const change = (seq: number, over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  entity: 'channel_settle_notes',
  op: 'insert',
  before: null,
  after: { id: `n${seq}`, orgId: 'o1', title: 't', body: 'b' },
  lsn: String(seq).padStart(16, '0'),
  txid: String(seq),
  orgId: 'o1',
  at: 0,
  ...over,
});

describe('a node that may have missed a change', () => {
  test('reopens every records topic: members are told, and an old cursor is never replayed across the hole', async () => {
    const { hub, ws, join } = rig();
    const name = await join();
    hub.deliverChange(change(1));
    hub.deliverChange(change(2));
    const before = ws.frames.filter((frame) => frame.type === 'records');
    const held = before.at(-1);
    if (held?.type !== 'records') return expect.unreachable('two records frames were delivered');
    ws.frames.length = 0;

    // Two changes are lost on the bus; the node learns only that it reconnected.
    expect(hub.invalidate()).toBe(1);

    expect(ws.frames).toEqual([expect.objectContaining({ type: 'replay-gap', channel: name })]);
    const gap = ws.frames[0];
    expect(gap?.type === 'replay-gap' && gap.epoch).not.toBe(held.epoch);
    // The next change is seq 1 of a NEW epoch, never seq 3 of the old one.
    hub.deliverChange(change(5));
    const next = ws.frames.at(-1);
    expect(next?.type === 'records' && next.epoch).not.toBe(held.epoch);
    // And a resubscribe from the old cursor is told to re-read, not handed the survivor.
    ws.frames.length = 0;
    await join('o1', { epoch: held.epoch, seq: held.seq });
    expect(ws.frames.map((frame) => frame.type)).toEqual(['replay-gap']);
  });
});

describe('a change that could not carry the row whole', () => {
  test('is a gap on its topic, never a partial record adopted into the ring', async () => {
    const { hub, ws } = rig();
    const name = await hub.subscribeChannel(rig().socket, {
      kind: 'channel',
      channel: 'settle-all',
      params: {},
    });
    const partial = change(1, {
      op: 'update',
      after: { id: 'n1', orgId: 'o1', title: 'renamed' },
      omitted: ['body'],
    });

    const [update] = updatesFor([everyone], partial);
    expect(update?.gap).toBe(true);
    expect(update?.adopt).toEqual([]);
    // A column the record does not project changes nothing.
    const [whole] = updatesFor([everyone], { ...partial, omitted: ['search_vector'] });
    expect(whole?.gap).toBeUndefined();
    expect(whole?.adopt).toHaveLength(1);
    expect(name).toBe(everyone.topic({}));
    expect(ws.frames).toEqual([]);
  });

  test('its members are told to re-read, and the ring starts over', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    const ws = new FakeWs();
    const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor: alice });
    sockets.add(socket);
    await hub.subscribeChannel(socket, { kind: 'channel', channel: 'settle-all', params: {} });
    ws.frames.length = 0;

    hub.deliverChange(
      change(1, { op: 'update', after: { id: 'n1', orgId: 'o1', title: 'x' }, omitted: ['body'] }),
    );

    expect(ws.frames.map((frame) => frame.type)).toEqual(['replay-gap']);
  });
});
