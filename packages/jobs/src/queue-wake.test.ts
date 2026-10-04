// The cross-process wake against a scripted listener: what proves it, what un-proves it, how it
// retries, and what each notification turns into. Time is the injected `setTimer` — nothing here
// waits. The real round trips are `queue-wake.job.test.ts` (embedded Postgres) and
// `queue-wake.live.test.ts` (a server, and a killed session).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LogSink, PgExecutor } from '@ultimat3/core';
import { createContext, frozenClock, setLogSink } from '@ultimat3/core';
import { createMemoryDriver } from './driver-memory';
import { JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL, SQL_WAKE } from './driver-pg-wake-sql';
import { onEnqueued, onStaged, setWakeLive, signalStaged, wakeIsLive } from './enqueue-signal';
import {
  createIdleBackoff,
  IDLE_POLL_CEILING_MS,
  WOKEN_IDLE_POLL_CEILING_MS,
} from './idle-backoff';
import { createMemoryOutboxStore } from './outbox';
import { createOutboxRelay } from './outbox-relay';
import type { PgListener } from './queue-wake';
import { startQueueWake } from './queue-wake';
import { createWorker } from './worker';

interface Scripted {
  readonly listener: PgListener;
  readonly executor: PgExecutor;
  /** Channels subscribed, in order — one entry per successful `listen`. */
  readonly listens: string[];
  unlistens: number;
  /** Probes the pool was asked to send: `[channel, payload]`. */
  readonly probes: (readonly [string, string])[];
  /** The server delivers one notification. */
  notify(channel: string, payload: string): void;
  /** The driver re-dialled the session: every channel announces itself again. */
  redial(): void;
  /** Timers armed and not yet fired or cancelled, as their delays. */
  pending(): readonly number[];
  /** Fire the earliest armed timer. */
  fire(): void;
  readonly setTimer: (run: () => void, delayMs: number) => () => void;
}

function scripted(options: { listenFailures?: number; probeFailures?: number } = {}): Scripted {
  let listenFailures = options.listenFailures ?? 0;
  let probeFailures = options.probeFailures ?? 0;
  const subscriptions = new Map<string, { notify(payload: string): void; listening?(): void }>();
  const timers: { run(): void; delayMs: number }[] = [];
  const script: Scripted = {
    listens: [],
    unlistens: 0,
    probes: [],
    listener: {
      async listen(channel, onNotify, onListening) {
        if (listenFailures > 0) {
          listenFailures -= 1;
          // What the driver answers with: input to the code under test, not this test's verdict.
          return Promise.reject(new Error('connect ECONNREFUSED'));
        }
        script.listens.push(channel);
        subscriptions.set(channel, {
          notify: onNotify,
          ...(onListening === undefined ? {} : { listening: onListening }),
        });
        onListening?.();
        return {
          unlisten: async () => {
            script.unlistens += 1;
            subscriptions.delete(channel);
          },
        };
      },
    },
    executor: {
      async query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        expect(sql).toBe(SQL_WAKE);
        if (probeFailures > 0) {
          probeFailures -= 1;
          return Promise.reject(new Error('pool timeout'));
        }
        script.probes.push([String(params[0]), String(params[1])]);
        return [];
      },
    },
    notify: (channel, payload) => subscriptions.get(channel)?.notify(payload),
    redial: () => {
      for (const subscription of subscriptions.values()) subscription.listening?.();
    },
    pending: () => timers.map((timer) => timer.delayMs),
    fire: () => timers.shift()?.run(),
    setTimer: (run, delayMs) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  };
  return script;
}

/** Let the dial, and the probe behind it, run to their next await. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const lines: { event: string; level: string; fix?: string }[] = [];
let previous: LogSink | undefined;

beforeEach(() => {
  lines.length = 0;
  previous = setLogSink((line, level) => {
    const parsed = JSON.parse(line) as { msg?: string; event?: string; fix?: string };
    lines.push({
      event: parsed.msg ?? parsed.event ?? line,
      level,
      ...(parsed.fix === undefined ? {} : { fix: parsed.fix }),
    });
  });
});

afterEach(() => {
  setLogSink(previous);
  setWakeLive(false);
});

const logged = (event: string) => lines.filter((line) => line.event === event);

describe('the cross-process wake', () => {
  test('it is live only once a notification has crossed BOTH channels', async () => {
    const script = scripted();
    const wake = startQueueWake({ ...script, verifyTimeoutMs: 5_000 });
    await settle();

    expect(script.listens).toEqual([JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL]);
    // One probe per channel, sent through the POOL, and only after both were subscribed. The
    // payload is empty: it names no queue, so it wakes every loop — the catch-up.
    expect(script.probes).toEqual([
      [JOBS_WAKE_CHANNEL, ''],
      [OUTBOX_WAKE_CHANNEL, ''],
    ]);
    expect(wake.live()).toBe(false);
    expect(wakeIsLive()).toBe(false);

    script.notify(JOBS_WAKE_CHANNEL, '');
    expect(wakeIsLive()).toBe(false);
    script.notify(OUTBOX_WAKE_CHANNEL, '');
    expect(wake.live()).toBe(true);
    expect(wakeIsLive()).toBe(true);
    expect(logged('jobs.wake.live')).toHaveLength(1);
    // The verdict timer went with the proof.
    expect(script.pending()).toEqual([]);
    await wake.stop();
  });

  test('a notification becomes the in-process signal: the queue it names, or any, or a COMMITTED stage', async () => {
    const script = scripted();
    const wake = startQueueWake(script);
    await settle();
    const enqueued: (string | undefined)[] = [];
    const staged: (boolean | undefined)[] = [];
    const off = [
      onEnqueued((queue) => enqueued.push(queue)),
      onStaged((committed) => staged.push(committed)),
    ];
    try {
      script.notify(JOBS_WAKE_CHANNEL, 'mail');
      script.notify(JOBS_WAKE_CHANNEL, '');
      script.notify(OUTBOX_WAKE_CHANNEL, '');
      expect(enqueued).toEqual(['mail', undefined]);
      expect(staged).toEqual([true]);
    } finally {
      for (const unsubscribe of off) unsubscribe();
      await wake.stop();
    }
  });

  test('a subscription that cannot be opened is retried on a doubling wait, and nothing is half-held', async () => {
    const script = scripted({ listenFailures: 2 });
    const wake = startQueueWake({
      ...script,
      retryBaseMs: 1_000,
      retryMaxMs: 30_000,
      // The top of the jitter band, so the schedule is the curve itself.
      random: () => 1,
    });
    await settle();
    expect(script.listens).toEqual([]);
    expect(script.pending()).toEqual([1_000]);
    expect(wakeIsLive()).toBe(false);

    script.fire();
    await settle();
    expect(script.pending()).toEqual([2_000]);
    expect(logged('jobs.wake.listen-failed')).toHaveLength(2);

    script.fire();
    await settle();
    expect(script.listens).toEqual([JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL]);
    script.notify(JOBS_WAKE_CHANNEL, '');
    script.notify(OUTBOX_WAKE_CHANNEL, '');
    expect(wakeIsLive()).toBe(true);
    await wake.stop();
  });

  test('the second channel failing hands the first one back before the retry', async () => {
    const script = scripted();
    const flaky: PgListener = {
      listen(channel, onNotify, onListening) {
        if (channel === OUTBOX_WAKE_CHANNEL && script.listens.length === 1) {
          script.listens.push('refused');
          return Promise.reject(new Error('too many connections'));
        }
        return script.listener.listen(channel, onNotify, onListening);
      },
    };
    const wake = startQueueWake({ ...script, listener: flaky, random: () => 1 });
    await settle();
    expect(script.unlistens).toBe(1);
    // No probe for a subscription that never completed.
    expect(script.probes).toEqual([]);
    script.fire();
    await settle();
    expect(script.listens).toEqual([
      JOBS_WAKE_CHANNEL,
      'refused',
      JOBS_WAKE_CHANNEL,
      OUTBOX_WAKE_CHANNEL,
    ]);
    await wake.stop();
  });

  test('a probe that never comes back is reported once, with the fix, and the wake stays unproven', async () => {
    const script = scripted();
    const wake = startQueueWake({ ...script, verifyTimeoutMs: 5_000 });
    await settle();
    // A transaction-pooling proxy: the LISTEN "succeeded", and nothing is ever delivered.
    expect(script.pending()).toEqual([5_000]);
    script.fire();
    const [warning] = logged('jobs.wake.unverified');
    expect(warning?.level).toBe('warn');
    expect(warning?.fix).toContain('pool_mode = session');
    expect(warning?.fix).toContain('idlePollMaxMs');
    expect(wakeIsLive()).toBe(false);

    // The proxy does not change between probes: a re-dial that also proves nothing says nothing.
    script.redial();
    await settle();
    script.fire();
    expect(logged('jobs.wake.unverified')).toHaveLength(1);
    await wake.stop();
  });

  test('a re-dialled session is unproven until its own probe crosses', async () => {
    const script = scripted();
    const wake = startQueueWake(script);
    await settle();
    script.notify(JOBS_WAKE_CHANNEL, '');
    script.notify(OUTBOX_WAKE_CHANNEL, '');
    expect(wakeIsLive()).toBe(true);
    const before = script.probes.length;

    script.redial();
    // What was notified while the session was down is gone: not live, and probed again.
    expect(wakeIsLive()).toBe(false);
    await settle();
    expect(script.probes.length).toBeGreaterThan(before);
    script.notify(JOBS_WAKE_CHANNEL, 'default');
    script.notify(OUTBOX_WAKE_CHANNEL, '');
    expect(wakeIsLive()).toBe(true);
    await wake.stop();
  });

  test('a probe the pool refused is retried, not taken for a verdict', async () => {
    const script = scripted({ probeFailures: 1 });
    const wake = startQueueWake({ ...script, random: () => 1 });
    await settle();
    // The jobs channel's probe was the one refused.
    expect(script.probes.map(([channel]) => channel)).toEqual([OUTBOX_WAKE_CHANNEL]);
    expect(logged('jobs.wake.probe-failed')).toHaveLength(1);
    expect(script.pending()).toEqual([1_000]);
    script.fire();
    await settle();
    // Both again: a probe is cheap, and which half of the last one landed is not tracked.
    expect(script.probes.slice(1).map(([channel]) => channel)).toEqual([
      JOBS_WAKE_CHANNEL,
      OUTBOX_WAKE_CHANNEL,
    ]);
    expect(logged('jobs.wake.unverified')).toEqual([]);
    await wake.stop();
  });

  test('stop() ends both subscriptions once, cancels every timer, and un-proves the wake', async () => {
    const script = scripted();
    const wake = startQueueWake(script);
    await settle();
    script.notify(JOBS_WAKE_CHANNEL, '');
    script.notify(OUTBOX_WAKE_CHANNEL, '');
    expect(wakeIsLive()).toBe(true);

    await Promise.all([wake.stop(), wake.stop()]);
    expect(script.unlistens).toBe(2);
    expect(wake.live()).toBe(false);
    expect(wakeIsLive()).toBe(false);
    expect(script.pending()).toEqual([]);
  });

  test('a stop() that lands mid-dial still hands back what the dial opens', async () => {
    const script = scripted();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow: PgListener = {
      async listen(channel, onNotify, onListening) {
        await gate;
        return script.listener.listen(channel, onNotify, onListening);
      },
    };
    const wake = startQueueWake({ ...script, listener: slow });
    const stopped = wake.stop();
    open();
    await stopped;
    await settle();
    expect(script.listens).toEqual([JOBS_WAKE_CHANNEL]);
    expect(script.unlistens).toBe(1);
    expect(script.probes).toEqual([]);
    expect(wakeIsLive()).toBe(false);
  });

  test('a non-finite knob is refused, not read as zero', () => {
    const script = scripted();
    expect(() => startQueueWake({ ...script, verifyTimeoutMs: Number.NaN })).toThrow(/X_INVARIANT/);
  });
});

describe('the idle ceiling follows the wake', () => {
  test('2 s while nothing but the poll can find a job, 5 s once the wake is proven', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 250 });
    const idle = (): number[] => [1, 2, 3, 4, 5, 6, 7].map(() => backoff.next(false));
    expect(idle()).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000]);
    expect(IDLE_POLL_CEILING_MS).toBe(2_000);

    setWakeLive(true);
    backoff.reset();
    expect(idle()).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(WOKEN_IDLE_POLL_CEILING_MS).toBe(5_000);

    // Lost again — a session that died, a proxy put in front: back under the guarantee at once.
    setWakeLive(false);
    expect(backoff.next(false)).toBe(2_000);
  });

  test('a declared idlePollMaxMs is the ceiling either way', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 250, ceilingMs: 1_000 });
    setWakeLive(true);
    expect([1, 2, 3, 4].map(() => backoff.next(false))).toEqual([250, 500, 1_000, 1_000]);
  });
});

describe('an idle minute with a proven wake', () => {
  const MINUTE = 60_000;

  test('a worker converges to one claim every five seconds: 15 statements a minute, was 33', async () => {
    setWakeLive(true);
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const driver = createMemoryDriver({ clock });
    let claims = 0;
    const worker = createWorker({
      driver: {
        ...driver,
        claim: (options) => {
          claims += 1;
          return driver.claim(options);
        },
      },
      queues: ['default', 'mail'],
      clock,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await worker.tick();
      const { pollDelayMs } = await worker.stats();
      delays.push(pollDelayMs);
      elapsed += pollDelayMs;
    }
    expect(delays.slice(0, 7)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    // The first pass asks each queue once; every one after it is a single statement.
    expect(claims).toBe(2 + (delays.length - 1));
    expect(claims).toBe(17);
    // Steady state, once the ramp is behind it: twelve a minute.
    expect(MINUTE / WOKEN_IDLE_POLL_CEILING_MS).toBe(12);
  });

  test('a relay converges to one claim every five seconds: 16 a minute, was 33', async () => {
    setWakeLive(true);
    let claims = 0;
    const store = createMemoryOutboxStore();
    const relay = createOutboxRelay({
      driver: createMemoryDriver(),
      store: {
        ...store,
        claim: (limit) => {
          claims += 1;
          return store.claim(limit);
        },
      },
      drainOnShutdown: false,
    });
    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await relay.tick();
      delays.push(relay.pollDelayMs());
      elapsed += relay.pollDelayMs();
    }
    expect(delays.slice(0, 7)).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(claims).toBe(16);
  });
});

describe('the relay hears a COMMITTED stage', () => {
  const relayOver = (onClaim: () => void) => {
    const store = createMemoryOutboxStore();
    return createOutboxRelay({
      driver: createMemoryDriver(),
      store: {
        ...store,
        claim: (limit) => {
          onClaim();
          return store.claim(limit);
        },
      },
      drainOnShutdown: false,
    });
  };

  test('a committed row is a pass NOW; a row this process staged is a pass at the floor', async () => {
    const script = scripted();
    const wake = startQueueWake(script);
    await settle();
    let claims = 0;
    const relay = relayOver(() => {
      claims += 1;
    });
    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(relay.pollDelayMs()).toBe(800);
    relay.start();
    try {
      // Still inside its transaction: the wait is cut to the floor, not to nothing.
      signalStaged();
      expect(relay.pollDelayMs()).toBe(200);
      const before = claims;
      script.notify(OUTBOX_WAKE_CHANNEL, '');
      expect(relay.pollDelayMs()).toBe(0);
      await Bun.sleep(5);
      expect(claims).toBe(before + 1);
    } finally {
      await relay.stop();
      await wake.stop();
    }
  });
});
