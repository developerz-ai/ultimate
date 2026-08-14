import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  beginWork,
  configureLifecycle,
  drain,
  healthzPayload,
  idleWaiterCount,
  inflightCount,
  isDraining,
  lifecycleState,
  markReady,
  onShutdown,
  readyzPayload,
  resetLifecycle,
  shutdownHookCount,
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

describe('lifecycle', () => {
  test('health state machine: starting -> ready -> draining -> stopped', async () => {
    expect(lifecycleState()).toBe('starting');
    expect(readyzPayload().status).toBe(503);
    expect(healthzPayload().status).toBe(200);

    markReady();
    expect(readyzPayload()).toMatchObject({ ok: true, status: 200 });

    const drained = drain('SIGTERM');
    expect(lifecycleState()).toBe('draining');
    expect(isDraining()).toBe(true);
    // Liveness stays green while draining; readiness does not.
    expect(healthzPayload().status).toBe(200);
    expect(readyzPayload().status).toBe(503);

    await drained;
    expect(lifecycleState()).toBe('stopped');
    expect(healthzPayload().status).toBe(503);
  });

  test('runs phases in order and waits for in-flight work before closing', async () => {
    const order: string[] = [];
    markReady();

    onShutdown(
      'stop-accepting',
      () => {
        order.push('accept');
      },
      { phase: 'accept' },
    );
    onShutdown(
      'flush-queue',
      () => {
        order.push('inflight');
      },
      { phase: 'inflight' },
    );
    onShutdown(
      'close-db',
      () => {
        order.push('close');
      },
      { phase: 'close' },
    );

    const finish = beginWork();
    expect(inflightCount()).toBe(1);

    const drained = drain('SIGTERM');
    await Bun.sleep(5);
    // The accept hook has run, but close must not have — work is still in flight.
    expect(order).toEqual(['accept']);

    order.push('work-done');
    finish();
    await drained;

    expect(order).toEqual(['accept', 'work-done', 'inflight', 'close']);
    expect(inflightCount()).toBe(0);
  });

  test('a hung handler is abandoned at the deadline and logs X_SHUTDOWN_TIMEOUT', async () => {
    const lines: string[] = [];
    configureLifecycle({
      deadlineMs: 10,
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    markReady();
    beginWork();

    await drain('SIGTERM');

    expect(lifecycleState()).toBe('stopped');
    expect(lines.some((line) => line.includes('X_SHUTDOWN_TIMEOUT'))).toBe(true);
  });

  test('a timed-out waiter does not linger after the drain gives up', async () => {
    configureLifecycle({ deadlineMs: 10 });
    markReady();
    beginWork(); // never completed — forces waitForIdle to time out, not resolve early

    await drain('SIGTERM');

    expect(lifecycleState()).toBe('stopped');
    // Before the fix this stayed 1 forever: the timeout branch resolved the promise but never
    // removed its own closure from `idleWaiters`, so a later `finish()` would still invoke it.
    expect(idleWaiterCount()).toBe(0);
  });

  test('an unregistered hook is gone from the table, and never runs again', async () => {
    let ran = 0;
    const unregister = onShutdown('gone', () => {
      ran += 1;
    });
    onShutdown('kept', () => undefined);
    expect(shutdownHookCount()).toBe(2);

    unregister();
    expect(shutdownHookCount()).toBe(1);

    await drain('SIGTERM');
    expect(ran).toBe(0);
  });

  test('concurrent signals join the same drain and a failing hook does not stop it', async () => {
    const lines: string[] = [];
    configureLifecycle({
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    let closed = 0;
    onShutdown('bad', () => {
      throw new Error('close failed');
    });
    onShutdown('good', () => {
      closed += 1;
    });

    await Promise.all([drain('SIGTERM'), drain('SIGINT')]);

    expect(closed).toBe(1);
    expect(lines.some((line) => line.includes('shutdown hook failed'))).toBe(true);
  });
});
