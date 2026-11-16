// The announcer tells no listener before the server holds the re-sent SUBs — the flush answers
// first — and one listener that throws stops no other. The real server is the live suite's
// (`nats-transport-announce.live.test.ts`); this is the order, with a flush held open by hand.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { NatsClient } from './nats-client';
import { NatsReconnectAnnouncer } from './nats-subscriptions';

function heldClient(connected: boolean): { client: NatsClient; answer(): void; flushes: number } {
  let answer: () => void = () => undefined;
  const state = {
    flushes: 0,
    answer: () => answer(),
    client: {
      connected,
      flush: () => {
        state.flushes += 1;
        return new Promise<void>((resolve) => {
          answer = resolve;
        });
      },
    } as unknown as NatsClient,
  };
  return state;
}

describe('NatsReconnectAnnouncer', () => {
  test('no listener is told until the flush answers', async () => {
    const told: string[] = [];
    const announcer = new NatsReconnectAnnouncer(() => undefined);
    announcer.on(() => told.push('a'));
    const held = heldClient(true);

    const announced = announcer.announce(held.client);
    await Promise.resolve();
    expect(held.flushes).toBe(1);
    expect(told).toEqual([]);

    held.answer();
    await announced;
    expect(told).toEqual(['a']);
  });

  test('a client with no connection is not asked; a throwing listener is reported, the rest told', async () => {
    const told: string[] = [];
    const faults: unknown[] = [];
    const announcer = new NatsReconnectAnnouncer((error) => faults.push(error));
    announcer.on(() => {
      throw new UltimateError({ code: 'X_INVARIANT', cause: 'a listener broke', fix: 'none' });
    });
    const off = announcer.on(() => told.push('gone'));
    announcer.on(() => told.push('b'));
    off();
    const held = heldClient(false);

    await announcer.announce(held.client);

    expect(held.flushes).toBe(0);
    expect(told).toEqual(['b']);
    expect(faults).toHaveLength(1);
  });
});
