// The cross-process wake's double: a scripted LISTEN session, a pool that can be refused or held,
// and the timers as a list a test fires by hand. Shared by the queue-wake suites; never shipped.

import { expect } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { SQL_WAKE } from './driver-pg-wake-sql';
import type { PgListener } from './queue-wake';

export interface Scripted {
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
  /** Hold every statement the pool is sent from here on — a saturated pool; answers the release. */
  stall(): () => void;
  readonly setTimer: (run: () => void, delayMs: number) => () => void;
}

export function scripted(
  options: { listenFailures?: number; probeFailures?: number } = {},
): Scripted {
  let listenFailures = options.listenFailures ?? 0;
  let probeFailures = options.probeFailures ?? 0;
  const subscriptions = new Map<string, { notify(payload: string): void; listening?(): void }>();
  const timers: { run(): void; delayMs: number }[] = [];
  let held: Promise<void> | undefined;
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
        if (held !== undefined) await held;
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
    stall: () => {
      let release: () => void = () => undefined;
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
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
export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
