// The reconnect: the one behaviour of `client.ts` no other suite can reach, because `hooks.test.ts`
// drives the client but has to call `connect()` a second time by hand. Everything here is about the
// timer — that it is armed, that it dials, that the server's delay survives the close it triggers,
// and that `close()` cancels it. The scheduler is injected, so nothing sleeps.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Topic } from './channel';
import { type ClientSocket, LiveClient, type SignalFactory } from './client';
import type { Row } from './json';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';
import type { BackoffPolicy, Scheduler } from './thundering-herd';

/** Synchronous and closure-backed: enough to prove an accessor re-reads, with no reactive runtime. */
const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

/** No jitter, so a delay is a number the test can name rather than a range it has to bracket. */
const backoff: BackoffPolicy = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 'none' };

class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #closed: ((code: number) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.#closed?.(code ?? 1000);
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.#closed = handler;
  }

  open(): void {
    this.#open?.();
  }

  deliver(frame: Frame): void {
    this.#message?.(JSON.stringify(frame));
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

/** The fake timer. `fire()` is all that advances a reconnect — no wall clock, nothing sleeps. */
class ManualScheduler {
  #armed: { fn: () => void; ms: number } | null = null;
  /** Every delay ever armed, in order, so a backoff curve is assertable after the fact. */
  readonly delays: number[] = [];

  readonly schedule: Scheduler = (fn, ms) => {
    this.#armed = { fn, ms };
    this.delays.push(ms);
    const mine = this.#armed;
    return () => {
      if (this.#armed === mine) this.#armed = null;
    };
  };

  get pending(): number | null {
    return this.#armed?.ms ?? null;
  }

  fire(): void {
    const armed = this.#armed;
    if (armed === null) throw new Error('nothing armed');
    this.#armed = null;
    armed.fn();
  }
}

interface Harness {
  readonly client: LiveClient;
  readonly timers: ManualScheduler;
  /** Every socket the client dialled, oldest first. A reconnect is a new entry here. */
  readonly sockets: FakeSocket[];
  readonly clock: ReturnType<typeof frozenClock>;
  /** Makes the next `count` dials throw — the socket constructor a browser is allowed to refuse. */
  failNextDials(count: number): void;
}

function harness(): Harness {
  const timers = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const clock = frozenClock(1_000);
  let failures = 0;
  const client = new LiveClient({
    signal,
    connect: () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('socket refused');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    buildId: 'build-1',
    backoff,
    clock,
    scheduler: timers.schedule,
  });
  return {
    client,
    timers,
    sockets,
    clock,
    failNextDials: (count) => {
      failures = count;
    },
  };
}

const feed = { name: 'feed' };

describe('LiveClient reconnect', () => {
  test('a dropped socket arms a timer that actually dials again', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    expect(client.connected).toBe(true);

    sockets[0]?.close(1006);
    expect(client.connected).toBe(false);
    expect(sockets).toHaveLength(1); // nothing dials synchronously — the delay is the whole point
    expect(timers.pending).toBe(500);

    timers.fire();
    expect(sockets).toHaveLength(2); // the timer called connect(), which is the bug this closes
    sockets[1]?.open();
    expect(client.connected).toBe(true);
  });

  test('reconnectAt is the armed delay, and clears once the socket is back', () => {
    const { client, timers, sockets, clock } = harness();
    client.connect();
    sockets[0]?.open();
    expect(client.reconnectAt()).toBeNull();

    sockets[0]?.close(1006);
    expect(client.reconnectAt()).toBe(clock.now().getTime() + 500);

    timers.fire();
    // Still set while dialling: a countdown that blinks to null mid-attempt reads as "connected".
    expect(client.reconnectAt()).toBe(1_500);
    sockets[1]?.open();
    expect(client.reconnectAt()).toBeNull();
  });

  test('successive failures back off, and a successful open resets the curve', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.close(1006);
    timers.fire();
    sockets[1]?.close(1006); // dialled, never opened
    timers.fire();
    sockets[2]?.close(1006);
    expect(timers.delays).toEqual([500, 1000, 2000]);

    timers.fire();
    sockets[3]?.open(); // this one lands
    sockets[3]?.close(1006);
    expect(timers.delays.at(-1)).toBe(500); // attempt counter reset on open
  });

  test('the whole subscription set is re-established on the automatic reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.useLive<Row>(feed, { orgId: 'o1' });

    sockets[0]?.close(1006);
    timers.fire();
    sockets[1]?.open();

    const kinds = sockets[1]?.frames().map((frame) => frame.type) ?? [];
    expect(kinds).toEqual(['hello', 'subscribe']);
  });

  test('a server-assigned delay survives the close it triggers', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.deliver({
      type: 'reconnect',
      v: PROTOCOL_VERSION,
      afterMs: 7_777,
      reason: 'drain',
    });

    // The close the frame triggers must not overwrite the node's spread slot with a local backoff.
    expect(timers.delays).toEqual([7_777]);
    expect(timers.pending).toBe(7_777);
    expect(sockets[0]?.closes).toEqual([{ code: 1001, reason: 'drain' }]);
  });

  test('a close never stacks a second timer on top of an armed one', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.close(1006);
    sockets[0]?.close(1006); // a socket that reports its close twice
    expect(timers.delays).toEqual([500]);

    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  test('a dial that throws arms the next attempt instead of ending the chain', () => {
    const { client, timers, sockets, failNextDials } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);

    failNextDials(1);
    expect(() => timers.fire()).toThrow('socket refused');
    expect(sockets).toHaveLength(1); // the dial produced nothing…
    expect(timers.pending).toBe(1000); // …and the chain is still armed, one attempt further on

    timers.fire();
    sockets[1]?.open();
    expect(client.connected).toBe(true);
  });

  test('a connect() the caller made itself arms nothing when it throws', () => {
    const { client, timers, failNextDials } = harness();
    failNextDials(1);

    // The timer owns the chain; a direct call is the app's, and swallowing it here would retry
    // behind the back of a caller who is holding the error.
    expect(() => client.connect()).toThrow('socket refused');
    expect(timers.pending).toBeNull();
  });

  test('an explicit connect() cancels the pending reconnect instead of racing it', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);
    expect(timers.pending).toBe(500);

    client.connect();
    expect(timers.pending).toBeNull();
    sockets[1]?.open();
    expect(sockets).toHaveLength(2); // the cancelled timer never dialled a third
  });
});

describe('LiveClient.close', () => {
  test('cancels the armed reconnect and never dials again', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);
    expect(timers.pending).toBe(500);

    client.close();
    expect(timers.pending).toBeNull();
    expect(client.reconnectAt()).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  test('closes the live socket without the close re-arming a reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    client.close(1000, 'bye');
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(client.connected).toBe(false);
    expect(timers.pending).toBeNull();
    expect(timers.delays).toEqual([]);
  });

  test('connect() after close() starts over rather than staying dead', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.close();

    client.connect();
    sockets[1]?.open();
    expect(client.connected).toBe(true);

    sockets[1]?.close(1006);
    expect(timers.pending).toBe(500);
  });
});

describe('LiveClient dead-socket writes', () => {
  test('a frame sent after the socket closed is dropped, not written into the corpse', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    sockets[0]?.close(1006);
    handle.unsubscribe(); // would have "sent" a drop frame nobody will ever read
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });

  test('a frame sent after close() is dropped too', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    client.close();
    handle.unsubscribe();
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });
});

describe('Disposable subscription handles', () => {
  test('using a useLive() handle sends the drop frame on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const before = sockets[0]?.sent.length ?? 0;

    {
      using handle = client.useLive<Row>(feed, { orgId: 'o1' });
      expect(handle.rows()).toEqual([]);
    }

    // add frame (subscribing) + drop frame (the `using` scope exiting).
    const sent = sockets[0]?.sent.slice(before) ?? [];
    expect(sent).toHaveLength(2);
    const dropFrame = decode(sent[1] ?? '') as Frame & { op?: string };
    expect(dropFrame.type).toBe('subscribe');
    expect(dropFrame.op).toBe('drop');
  });

  test('[Symbol.dispose] is the same function as unsubscribe(), not a second teardown path', () => {
    const { client } = harness();
    client.connect();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    expect(handle[Symbol.dispose]).toBe(handle.unsubscribe);
  });

  test('a topic subscription is still directly callable, and using it unsubscribes on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const messages: unknown[] = [];
    const before = sockets[0]?.sent.length ?? 0;

    {
      using unsub = client.subscribe('org.o1.cursors' as Topic, (message) => {
        messages.push(message);
      });
      expect(typeof unsub).toBe('function');
    }

    const sent = sockets[0]?.sent.slice(before) ?? [];
    // add frame (subscribing) + drop frame (the `using` scope exiting).
    expect(sent).toHaveLength(2);
    const dropFrame = decode(sent[1] ?? '') as Frame & { op?: string };
    expect(dropFrame.type).toBe('subscribe');
    expect(dropFrame.op).toBe('drop');
  });

  test('a topic Unsubscribe is directly callable as [Symbol.dispose]', () => {
    const { client } = harness();
    client.connect();
    const unsub = client.subscribe('org.o1.cursors' as Topic, () => {});
    expect(unsub[Symbol.dispose]).toBe(unsub);
  });
});
