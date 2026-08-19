// Single responsibility: an injected logger that THROWS cannot break the two answers that must
// arrive anyway — `drain()` still settles, /readyz still reports. `configureLifecycle({ logger })`
// takes whatever an app hands it, so every log call on those paths is an injection seam. Split
// from `lifecycle.test.ts` for the file-size ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureLifecycle,
  drain,
  lifecycleState,
  markReady,
  onShutdown,
  readyzPayload,
  registerReadinessCheck,
  resetLifecycle,
} from './lifecycle';
import { createLogger } from './logger';

// Lifecycle state is process-global, and any suite that boots a server calls `markReady()` — so
// this resets on the way IN as well as out, or the first assertion reads another file's process.
beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

describe('the logger is an injection seam', () => {
  test('a logger that throws cannot reject the drain', async () => {
    // `log` is an injection seam — `configureLifecycle({ logger })` takes whatever an app hands
    // it. `drain()`'s body logged outside any `try`, so a `Logger.info` that throws rejected
    // `drainPromise`: `state` never reached 'stopped', the memo re-rejected for every later
    // caller (`holdUntilShutdown`'s `await drain()` among them), and on Bun the unhandled
    // rejection ends the process mid-drain, with the pool still open.
    const fallback: string[] = [];
    const base = createLogger({ level: 'info', writer: (line) => fallback.push(line) });
    configureLifecycle({
      logger: {
        ...base,
        info(): never {
          throw new Error('the log sink is down');
        },
      },
    });
    let closed = 0;
    onShutdown('good', () => {
      closed += 1;
    });

    let settled = false;
    await drain('SIGTERM').then(() => {
      settled = true;
    });

    expect(settled).toBe(true);
    expect(closed).toBe(1);
    expect(lifecycleState()).toBe('stopped');
    // The memo is a resolved one, so the next caller joins a finished drain rather than a
    // rejection nobody is left to handle.
    await expect(drain('SIGTERM')).resolves.toBeUndefined();
  });

  test('a logger that throws cannot break /readyz either', async () => {
    // Same seam, same shape: a check that fails is reported through `log.warn`, so a logger that
    // dies there replaced the readiness answer with a throw — the probe 500s and the pod is
    // killed by the outage it was reporting on.
    const fallback: string[] = [];
    const base = createLogger({ level: 'warn', writer: (line) => fallback.push(line) });
    configureLifecycle({
      logger: {
        ...base,
        warn(): never {
          throw new Error('the log sink is down');
        },
      },
    });
    markReady();
    registerReadinessCheck('db', () => {
      throw new Error('pool is closed');
    });

    expect(readyzPayload().status).toBe(503);
    expect(readyzPayload().body.checks['db']).toBe('failing');
  });
});
