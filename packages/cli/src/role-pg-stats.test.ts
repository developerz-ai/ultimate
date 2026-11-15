// The scheduler samples the Postgres server's own health — on a real server only: the embedded
// database is one process's private copy, and its "connections" and "slots" describe no fleet.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { startRolePgStats } from './role-pg-stats';

function counting() {
  const sent: string[] = [];
  const executor: PgExecutor = {
    query: async <R>(text: string) => {
      sent.push(text);
      return [] as R[];
    },
  };
  return { sent, executor };
}

describe('unit · the scheduler pg stats sampler', () => {
  test('on an external database it samples at once, again per interval, and stops on stop()', async () => {
    const { sent, executor } = counting();
    const stop = startRolePgStats(['scheduler'], 'external', executor, 20);
    expect(stop).not.toBeNull();
    await Bun.sleep(5);
    const first = sent.length;
    expect(first).toBeGreaterThan(0);
    await Bun.sleep(50);
    const later = sent.length;
    expect(later).toBeGreaterThan(first);
    await stop?.();
    await Bun.sleep(50);
    expect(sent.length).toBe(later);
  });

  test('on the embedded database it starts nothing', async () => {
    const { sent, executor } = counting();
    expect(startRolePgStats(['scheduler'], 'embedded', executor, 20)).toBeNull();
    await Bun.sleep(30);
    expect(sent).toEqual([]);
  });

  test('a process with no scheduler role starts nothing', () => {
    const { executor } = counting();
    expect(startRolePgStats(['web', 'worker'], 'external', executor, 20)).toBeNull();
  });

  test('stop() waits out the sampling round in flight, so the pool never closes under it', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: PgExecutor = {
      query: async <R>() => {
        await held;
        return [] as R[];
      },
    };
    const stop = startRolePgStats(['scheduler'], 'external', executor, 60_000);
    if (stop === null) return expect.unreachable('the scheduler started the sampler');
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
