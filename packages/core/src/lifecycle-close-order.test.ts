// Resources are released in reverse of acquisition: a telemetry exporter registered first flushes
// last, so what a later hook records on its way down still reaches it. `accept` keeps registration
// order, because nothing in that phase releases anything.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drain, onShutdown, resetLifecycle, shutdownHookCount } from './lifecycle';

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

describe('the order a phase runs its hooks', () => {
  const register = (ran: string[], phase: 'accept' | 'inflight' | 'close'): void => {
    for (const name of ['first', 'second', 'third']) {
      onShutdown(
        `${phase}-${name}`,
        () => {
          ran.push(`${phase}-${name}`);
        },
        { phase },
      );
    }
  };

  test('`close` runs last-registered first, `accept` and `inflight` as registered', async () => {
    const ran: string[] = [];
    register(ran, 'close');
    register(ran, 'accept');
    register(ran, 'inflight');
    await drain('SIGTERM');
    expect(ran).toEqual([
      'accept-first',
      'accept-second',
      'accept-third',
      'inflight-first',
      'inflight-second',
      'inflight-third',
      'close-third',
      'close-second',
      'close-first',
    ]);
  });

  test('reversing does not disturb the registry: the count and an unregister hold', async () => {
    const ran: string[] = [];
    const hook = (name: string) => (): void => {
      ran.push(name);
    };
    onShutdown('a', hook('a'), { phase: 'close' });
    const dropped = onShutdown('b', hook('b'), { phase: 'close' });
    onShutdown('c', hook('c'), { phase: 'close' });
    expect(shutdownHookCount()).toBe(3);
    dropped();
    expect(shutdownHookCount()).toBe(2);
    await drain('SIGTERM');
    expect(ran).toEqual(['c', 'a']);
    expect(shutdownHookCount()).toBe(2);
  });
});
