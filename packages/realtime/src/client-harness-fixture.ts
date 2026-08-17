// The doubles two client suites drive: an injected socket, an injected scheduler, and the
// harness that wires a `LiveClient` to both. Shared rather than copied because `client.test.ts`
// and `client-reconnect.test.ts` must exercise the SAME client wiring — two harnesses that
// drifted would be two clients agreeing only by construction. A `-fixture.ts` file is test
// material and is excluded from the package tarball.

import { frozenClock } from '@ultimat3/core';
import { type ClientSocket, LiveClient, type SignalFactory } from './client';
import { decode, type Frame } from './sync-protocol';
import type { BackoffPolicy, Scheduler } from './thundering-herd';

/** A harness driven wrongly by a test, never a framework fault — so it carries no `X_*` code. */
export class HarnessMisuse extends Error {
  override readonly name = 'HarnessMisuse';
}

/** Synchronous and closure-backed: enough to prove an accessor re-reads, with no reactive runtime. */
export const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

/** No jitter, so a delay is a number the test can name rather than a range it has to bracket. */
export const backoff: BackoffPolicy = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 'none' };

export class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  /** What a browser socket reports as queued-but-unwritten. Set by a test to back the socket up. */
  bufferedAmount = 0;
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

/** The sid the client minted for its one registration, read off the subscribe frame it sent. */
export function decodeSid(socket: FakeSocket | undefined): string {
  const frame = socket?.frames().find((sent) => sent.type === 'subscribe');
  return frame?.type === 'subscribe' ? frame.sid : '';
}

/** The fake timer. `fire()` is all that advances a reconnect — no wall clock, nothing sleeps. */
export class ManualScheduler {
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
    // A throw, not `expect.unreachable`: `tsconfig.json` excludes tests, so a non-test file that
    // reaches for a matcher is invisible to `tsc` until the gate says otherwise. Same shape as
    // `@ultimat3/jobs`' backfill fixture — test material, kept out of the tarball by `files`.
    if (armed === null) throw new HarnessMisuse('fire() with nothing armed');
    this.#armed = null;
    armed.fn();
  }
}

export interface Harness {
  readonly client: LiveClient;
  readonly timers: ManualScheduler;
  /** Every socket the client dialled, oldest first. A reconnect is a new entry here. */
  readonly sockets: FakeSocket[];
  readonly clock: ReturnType<typeof frozenClock>;
  /** Everything the client reported through `onError`, in order. The host's `window.onerror`. */
  readonly errors: unknown[];
  /** Makes the next `count` dials throw — the socket constructor a browser is allowed to refuse. */
  failNextDials(count: number): void;
}

export interface HarnessOptions {
  /**
   * Off by default. `ManualScheduler` holds ONE armed timer, which is exactly right — a client is
   * either beating on a live socket or backing off towards a new one, never both — but a heartbeat
   * armed on every open would put its delay in `timers.delays`, where the reconnect suite reads the
   * backoff curve. The heartbeat suite turns it on and owns the clock.
   */
  readonly heartbeatMs?: number;
}

export function harness(options: HarnessOptions = {}): Harness {
  const timers = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const errors: unknown[] = [];
  const clock = frozenClock(1_000);
  let failures = 0;
  const client = new LiveClient({
    signal,
    heartbeatMs: options.heartbeatMs ?? 0,
    connect: () => {
      if (failures > 0) {
        failures -= 1;
        // What a browser actually throws when it refuses `new WebSocket(...)`, so the fixture is
        // the real failure rather than a framework error this code path can never produce.
        throw new TypeError('socket refused');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    buildId: 'build-1',
    backoff,
    clock,
    scheduler: timers.schedule,
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    client,
    timers,
    sockets,
    clock,
    errors,
    failNextDials: (count) => {
      failures = count;
    },
  };
}

export const feed = { name: 'feed' };
