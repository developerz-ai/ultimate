// What the hub owes when two sockets reach one topic at once, and what it owes a guard that could
// not decide. Both were read-then-act across an await: the bridge was looked up before the
// transport subscription and written after it, so one topic opened two — the first orphaned, every
// message on it delivered twice, and unreachable by `#release`, `close()` or a socket dying.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { ChannelHub, type Topic, topic } from './channel';
import {
  InProcessTransport,
  type Transport,
  type TransportHandler,
  type TransportSubscription,
} from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  readonly topics = new Set<string>();
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(name: string): void {
    this.topics.add(name);
  }
  unsubscribe(name: string): void {
    this.topics.delete(name);
  }
  getBufferedAmount(): number {
    return 0;
  }
}

/** A promise this test resolves by hand. Never a sleep: a race is not a duration. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The real transport with one seam: `subscribe` does not resolve until the test says so, and every
 * subscription it hands out is counted. A bridge opened twice is two `created` and one `live`.
 */
class SlowTransport implements Transport {
  readonly name = 'slow';
  readonly shared: Transport['shared'];
  created = 0;
  live = 0;
  readonly gate = deferred();
  readonly #inner = new InProcessTransport();

  constructor() {
    this.shared = this.#inner.shared;
  }

  async publish(subject: string, payload: string): Promise<void> {
    await this.#inner.publish(subject, payload);
  }

  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    this.created += 1;
    await this.gate.promise;
    const inner = await this.#inner.subscribe(subject, handler);
    this.live += 1;
    return {
      subject,
      unsubscribe: () => {
        this.live -= 1;
        inner.unsubscribe();
      },
    };
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });

function connect(sockets: SocketRegistry, who: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({ ws, clientBuildId: 'b', serverBuildId: 'b', actor: who });
  sockets.add(socket);
  return { socket, ws };
}

describe('one topic is one transport subscription, however many sockets arrive at once', () => {
  test('two concurrent subscribes to one topic open one bridge, not two', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets });
    hub.guard('org.>', () => true);
    const name = topic('org', 'o1', 'cursors');
    const alice = connect(sockets, actor('alice'));
    const bob = connect(sockets, actor('bob'));

    const both = Promise.all([hub.subscribe(alice.socket, name), hub.subscribe(bob.socket, name)]);
    transport.gate.resolve();
    await both;

    expect(transport.created).toBe(1);
    expect(hub.topicCount).toBe(1);

    // The orphan's real cost: it is a second live handler on the same subject, so every message
    // is delivered twice to every socket on this node — for the life of the process.
    await hub.publish(name, { x: 1, y: 1 });
    expect(alice.ws.frames).toHaveLength(1);
    expect(bob.ws.frames).toHaveLength(1);
  });

  test('one socket asking twice for one topic holds one reference, not two', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets });
    hub.guard('org.>', () => true);
    const name = topic('org', 'o1', 'cursors');
    const alice = connect(sockets, actor('alice'));

    const twice = Promise.all([
      hub.subscribe(alice.socket, name),
      hub.subscribe(alice.socket, name),
    ]);
    transport.gate.resolve();
    await twice;
    // The socket's one membership is what its close will give back, so a second reference taken
    // here is a bridge nothing will ever release.
    hub.unsubscribe(alice.socket, name);

    expect(hub.topicCount).toBe(0);
    await Promise.resolve();
    expect(transport.live).toBe(0);
  });

  test('the last unsubscribe releases everything the topic opened', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets });
    hub.guard('org.>', () => true);
    const name = topic('org', 'o1', 'cursors');
    const alice = connect(sockets, actor('alice'));
    const bob = connect(sockets, actor('bob'));

    const both = Promise.all([hub.subscribe(alice.socket, name), hub.subscribe(bob.socket, name)]);
    transport.gate.resolve();
    await both;
    hub.unsubscribe(alice.socket, name);
    hub.unsubscribe(bob.socket, name);
    // `close()` iterates the bridge table, so a subscription that never reached it survives both.
    await hub.close();

    expect(transport.live).toBe(0);
    expect(hub.topicCount).toBe(0);
  });

  test('a guard that denies one of two concurrent subscribers leaves the bridge to the other', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets });
    hub.guard('org.>', ({ actor: who }) => who?.id === 'alice');
    const name = topic('org', 'o1', 'cursors');
    const alice = connect(sockets, actor('alice'));
    const mallory = connect(sockets, actor('mallory'));

    const both = Promise.allSettled([
      hub.subscribe(alice.socket, name),
      hub.subscribe(mallory.socket, name),
    ]);
    transport.gate.resolve();
    const settled = await both;

    expect(settled[0]?.status).toBe('fulfilled');
    expect(settled[1]?.status).toBe('rejected');
    expect(hub.topicCount).toBe(1);
    await hub.publish(name, { x: 1, y: 1 });
    expect(alice.ws.frames).toHaveLength(1);
    expect(mallory.ws.frames).toHaveLength(0);

    // And the refused subscriber released the slot it took: the topic goes when alice does.
    hub.unsubscribe(alice.socket, name);
    expect(hub.topicCount).toBe(0);
    // One turn: the transport hands its handle back through a promise, so a bridge released while
    // that promise is in flight can only be closed when it lands.
    await Promise.resolve();
    expect(transport.live).toBe(0);
  });
});

describe('a batch of topic subscribes cannot outrun a cap', () => {
  test('the per-socket topic cap counts the subscribes still in flight', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, maxTopicsPerSocket: 2 });
    hub.guard('org.>', () => true);
    const alice = connect(sockets, actor('alice'));

    const batch = Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((leaf) => hub.subscribe(alice.socket, topic('org', 'o1', leaf))),
    );
    transport.gate.resolve();
    const settled = await batch;

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(2);
    for (const one of settled.filter((each) => each.status === 'rejected')) {
      expect(one.reason).toMatchObject({ code: 'X_SUBSCRIPTION_LIMIT' });
    }
    expect(alice.socket.topics.size).toBe(2);
  });

  test('the per-node topic cap counts them too', async () => {
    const transport = new SlowTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, maxTopicsPerNode: 2 });
    hub.guard('org.>', () => true);
    const alice = connect(sockets, actor('alice'));
    const bob = connect(sockets, actor('bob'));

    const batch = Promise.allSettled([
      hub.subscribe(alice.socket, topic('org', 'o1', 'a')),
      hub.subscribe(bob.socket, topic('org', 'o1', 'b')),
      hub.subscribe(alice.socket, topic('org', 'o1', 'c')),
      hub.subscribe(bob.socket, topic('org', 'o1', 'd')),
    ]);
    transport.gate.resolve();
    const settled = await batch;

    // Each distinct topic is one live transport subscription — the thing the node cap bounds.
    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(2);
    expect(hub.topicCount).toBe(2);
    expect(transport.created).toBe(2);
  });
});

class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

describe('a re-auth tells a denial from a guard that could not decide', () => {
  const rig = (
    guard: (who: Actor | null) => boolean,
  ): { hub: ChannelHub; sockets: SocketRegistry } => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    hub.guard('org.>', ({ actor: who }) => guard(who));
    return { hub, sockets };
  };

  test('a denial drops the topic', async () => {
    const { hub, sockets } = rig((who) => who?.id === 'alice');
    const alice = connect(sockets, actor('alice'));
    const name = topic('org', 'o1', 'cursors');
    await hub.subscribe(alice.socket, name);

    const dropped = await hub.onActorChange(alice.socket, actor('mallory'));

    expect(dropped).toEqual([name]);
    expect(alice.socket.topics.size).toBe(0);
    expect(hub.guardFailures).toBe(0);
  });

  test('a guard that RAISED keeps the topic, and is counted as a failure', async () => {
    let broken = false;
    const { hub, sockets } = rig((who) => {
      if (broken) throw new PoolTimeout('connection pool exhausted');
      return who !== null;
    });
    const alice = connect(sockets, actor('alice'));
    const name = topic('org', 'o1', 'cursors');
    await hub.subscribe(alice.socket, name);

    broken = true;
    const dropped = await hub.onActorChange(alice.socket, actor('alice-again'));

    // A guard is app code and may reach a database. Read as a denial, a re-auth pass during an
    // outage silently drops every topic on every re-authenticated socket on the node.
    expect(dropped).toEqual([]);
    expect(alice.socket.topics.has(name)).toBe(true);
    expect(hub.guardFailures).toBe(1);
  });

  test('the surviving topic still delivers once the store is back', async () => {
    let broken = false;
    const { hub, sockets } = rig(() => {
      if (broken) throw new PoolTimeout('connection pool exhausted');
      return true;
    });
    const alice = connect(sockets, actor('alice'));
    const name: Topic = topic('org', 'o1', 'cursors');
    await hub.subscribe(alice.socket, name);
    broken = true;
    await hub.onActorChange(alice.socket, actor('alice'));
    broken = false;

    await hub.publish(name, { x: 1, y: 1 });

    expect(alice.ws.frames).toHaveLength(1);
  });
});
