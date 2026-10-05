// The per-actor cap across a RE-AUTH, a socket close, a subscribe still in flight when its socket
// changes principal, a socket that can name no principal at all, and a ceiling that is not a count.
// Each is a way the count the cap reads could leak, overshoot, or be walked around.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

class RecordingWs implements WsLike {
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

/** A read that waits for `release()` — the window a subscribe is in flight in. */
const gated = () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, release: () => open() };
};

const definition = (wait?: Promise<void>): LiveQueryDefinition => ({
  name: 'feed',
  entities: ['posts'],
  async snapshot() {
    if (wait !== undefined) await wait;
    return { rows: [], lsn: formatLsn(1) };
  },
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
});

let sockets = 0;
const socketFor = (actor: Actor | null, clientAddress: string | null = null) => {
  sockets += 1;
  const ws = new RecordingWs();
  const socket = new SyncSocket({
    ws,
    id: `r-${String(sockets)}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor,
    clientAddress,
  });
  return { socket, ws };
};

const codeOf = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

const refusals = (ws: RecordingWs): readonly string[] =>
  ws.frames.flatMap((frame) =>
    frame.type === 'ack' && frame.error !== null ? [frame.error.code] : [],
  );

let inputs = 0;
const fill = async (registry: LiveQueryRegistry, socket: SyncSocket, count: number) => {
  for (let i = 0; i < count; i += 1) {
    inputs += 1;
    await registry.subscribe({ socket, name: 'feed', input: { n: inputs } });
  }
};

describe('a re-auth never leaves a principal above its cap', () => {
  test('moving onto a principal with no room refuses the overflow under each sid', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 3,
    }).register(definition());
    const b = userActor({ id: 'b' });
    await fill(registry, socketFor(b).socket, 2);
    const moving = socketFor(userActor({ id: 'a' }));
    await fill(registry, moving.socket, 3);

    moving.socket.actor = b;
    await registry.reauthorize(moving.socket);

    // `b` held 2 of 3: one of the three moving subscriptions fits, two are refused.
    expect(moving.socket.queries.size).toBe(1);
    expect(refusals(moving.ws)).toEqual(['X_SUBSCRIPTION_LIMIT', 'X_SUBSCRIPTION_LIMIT']);
    expect(
      await codeOf(registry.subscribe({ socket: socketFor(b).socket, name: 'feed', input: -1 })),
    ).toBe('X_SUBSCRIPTION_LIMIT');
  });

  test('filling an address, then signing in, cannot be repeated past the actor cap', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 2,
    }).register(definition());
    const mallory = userActor({ id: 'mallory' });
    for (let round = 0; round < 3; round += 1) {
      const anonymous = socketFor(null, '198.51.100.9');
      await fill(registry, anonymous.socket, 2);
      anonymous.socket.actor = mallory;
      await registry.reauthorize(anonymous.socket);
    }
    expect(
      await codeOf(
        registry.subscribe({ socket: socketFor(mallory).socket, name: 'feed', input: -2 }),
      ),
    ).toBe('X_SUBSCRIPTION_LIMIT');
    // Three rounds of two, and the actor holds its cap of two — not six.
    expect(registry.actorCount('actor:mallory')).toBe(2);
  });
});

describe('the book forgets a socket it no longer counts', () => {
  test('a re-auth on a socket holding nothing, then its close, leaves nothing remembered', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      definition(),
    );
    const before = registry.trackedSockets;
    const { socket } = socketFor(userActor({ id: 'a' }));
    socket.actor = userActor({ id: 'b' });
    await registry.reauthorize(socket);
    registry.unsubscribeSocket(socket.id);
    expect(registry.trackedSockets).toBe(before);
  });

  test('a socket that held subscriptions and re-authed is forgotten on close', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      definition(),
    );
    const before = registry.trackedSockets;
    const { socket } = socketFor(userActor({ id: 'a' }));
    await fill(registry, socket, 2);
    socket.actor = userActor({ id: 'b' });
    await registry.reauthorize(socket);
    registry.unsubscribeSocket(socket.id);
    expect(registry.trackedSockets).toBe(before);
  });
});

describe('a subscribe in flight across a re-auth', () => {
  test('attaching under a principal that filled meanwhile is refused', async () => {
    const { gate, release } = gated();
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 1,
    })
      .register(definition())
      .register({ ...definition(gate), name: 'slow' });
    const b = userActor({ id: 'b' });
    await fill(registry, socketFor(b).socket, 1);
    const { socket } = socketFor(userActor({ id: 'a' }));
    const pending = codeOf(registry.subscribe({ socket, name: 'slow', input: 1 }));
    socket.actor = b;
    release();
    expect(await pending).toBe('X_SUBSCRIPTION_LIMIT');
    expect(registry.actorCount('actor:b')).toBe(1);
  });
});

describe('a socket that names no principal still has one', () => {
  test('no actor and no address share one bounded principal', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 2,
    }).register(definition());
    await fill(registry, socketFor(null, null).socket, 2);
    expect(
      await codeOf(
        registry.subscribe({ socket: socketFor(null, null).socket, name: 'feed', input: -3 }),
      ),
    ).toBe('X_SUBSCRIPTION_LIMIT');
  });
});

describe('an anonymous IPv6 caller is one /64, not 2^64 principals', () => {
  test('two addresses in one /64 share a budget; another /64 does not', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 2,
    }).register(definition());
    await fill(registry, socketFor(null, '2001:db8:aa:bb::1').socket, 1);
    await fill(registry, socketFor(null, '2001:db8:aa:bb:ffff::2').socket, 1);
    const sameNet = socketFor(null, '2001:db8:aa:bb::3').socket;
    expect(await codeOf(registry.subscribe({ socket: sameNet, name: 'feed', input: -4 }))).toBe(
      'X_SUBSCRIPTION_LIMIT',
    );
    expect(registry.actorCount('address:2001:db8:aa:bb::/64')).toBe(2);
    const otherNet = socketFor(null, '2001:db8:aa:bc::1').socket;
    expect(await codeOf(registry.subscribe({ socket: otherNet, name: 'feed', input: -5 }))).toBe(
      'ok',
    );
  });
});

describe('maxPerActor is a count', () => {
  test.each([0, -1, 2.5, Number.NaN])('%p is refused with the config error', (maxPerActor) => {
    let code = 'accepted';
    try {
      new LiveQueryRegistry({ source: new RingChangeBuffer(), maxPerActor });
    } catch (error) {
      code = (error as { readonly code?: string }).code ?? 'uncoded';
    }
    expect(code).toBe('X_CONFIG_INVALID');
  });
});
