// The cross-process wake against a scripted listener: what proves it, what un-proves it, how it
// retries, and what each notification turns into. Time is the injected `setTimer` — nothing here
// waits. The real round trips are `queue-wake.job.test.ts` (embedded Postgres) and
// `queue-wake.live.test.ts` (a server, and a killed session).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { installLogSink } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL, SQL_WAKE } from './driver-pg-wake-sql';
import { onEnqueued, onStaged, setWakeLive, signalStaged, wakeIsLive } from './enqueue-signal';
import { useFakeTime } from './fake-time-fixture';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';
import type { PgListener } from './queue-wake';
import { startQueueWake } from './queue-wake';

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

const lines: { event: string; level: string; fix?: string; failures?: number }[] = [];
let releaseLogSink: () => void = () => undefined;

beforeEach(() => {
  lines.length = 0;
  releaseLogSink = installLogSink((line, level) => {
    const parsed = JSON.parse(line) as {
      msg?: string;
      event?: string;
      fix?: string;
      failures?: number;
    };
    lines.push({
      event: parsed.msg ?? parsed.event ?? line,
      level,
      ...(parsed.fix === undefined ? {} : { fix: parsed.fix }),
      ...(parsed.failures === undefined ? {} : { failures: parsed.failures }),
    });
  });
});

afterEach(() => {
  releaseLogSink();
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
    // The same refusal twice is one streak: one line, not one per retry.
    expect(logged('jobs.wake.listen-failed')).toHaveLength(1);
    expect(logged('jobs.wake.listen-recovered')).toEqual([]);

    script.fire();
    await settle();
    expect(script.listens).toEqual([JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL]);
    expect(logged('jobs.wake.listen-recovered')).toEqual([
      { event: 'jobs.wake.listen-recovered', level: 'info', failures: 2 },
    ]);
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
    expect(warning?.fix).toContain('unset DATABASE_POOLER');
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

  test('a probe refused on every retry is one line, and one more when a probe lands', async () => {
    // Each probe asks both channels: six refusals are three refused probes.
    const script = scripted({ probeFailures: 6 });
    const wake = startQueueWake({ ...script, random: () => 1 });
    await settle();
    for (let retry = 0; retry < 3; retry += 1) {
      script.fire();
      await settle();
    }
    expect(logged('jobs.wake.probe-failed')).toHaveLength(1);
    expect(logged('jobs.wake.probe-recovered')).toEqual([
      { event: 'jobs.wake.probe-recovered', level: 'info', failures: 3 },
    ]);
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

describe('the relay hears a COMMITTED stage', () => {
  const relayOver = (onClaim: () => void) => {
    const store = memoryOutboxStore();
    return outboxRelay({
      driver: memoryJobDriver(),
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

  // The relay's own timers are real `setTimeout`s: moved by hand here, a pass counted is one armed.
  describe('on fake time', () => {
    const time = useFakeTime();

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
        // One millisecond of fake time: the pass armed at 0 runs, the floor's (200) cannot.
        await time.advance(1, 1);
        expect(claims).toBe(before + 1);
      } finally {
        await time.settles(relay.stop(), 100);
        await wake.stop();
      }
    });
  });
});
