// `subscribed()` is the one way a live test knows the bus holds a subscription before it publishes:
// a probe published from the PUBLISHER's connection was heard. Driven here by a bus that loses
// every publish until it has "read" the SUB, the race a real server runs across two connections.

import { describe, expect, test } from 'bun:test';
import { probeSubjectFor, subscribed } from './bus-subscribed-fixture';
import { TransportUnavailableError } from './errors';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';

/**
 * The in-process bus, deaf until `lag` publishes have gone by after each (re)subscription — the
 * window in which a server has been sent the SUB and has not yet read it.
 */
function laggingBus(lag: number): { readonly bus: Transport; drop(): void } {
  const inner = new InProcessTransport();
  let deafFor = 0;
  const bus: Transport = {
    name: 'lagging',
    shared: inner.shared,
    onReconnect: () => () => undefined,
    close: () => inner.close(),
    async publish(subject, payload) {
      if (deafFor > 0) {
        deafFor -= 1;
        return;
      }
      await inner.publish(subject, payload);
    },
    async subscribe(subject, handler) {
      deafFor = lag;
      return await inner.subscribe(subject, handler);
    },
  };
  return {
    bus,
    drop: () => {
      deafFor = lag;
    },
  };
}

const noPause = (): Promise<void> => Promise.resolve();

describe('subscribed — a subscription is held once a probe through it was heard', () => {
  test('resolves only after a probe arrives, and the handler never sees one', async () => {
    const { bus } = laggingBus(3);
    const seen: string[] = [];
    const held = await subscribed({
      subscriber: bus,
      publisher: bus,
      subject: 'x.change.posts.*',
      handler: (payload) => seen.push(payload),
      pause: noPause,
    });

    await bus.publish('x.change.posts.org-1', 'first');

    expect(seen).toEqual(['first']);
    held.unsubscribe();
  });

  test('re-confirms after the connection came back, before the next publish', async () => {
    const lag = laggingBus(2);
    const seen: string[] = [];
    const held = await subscribed({
      subscriber: lag.bus,
      publisher: lag.bus,
      subject: 'x.change.reconnect.one',
      handler: (payload) => seen.push(payload),
      pause: noPause,
    });
    lag.drop();

    await held.subscribed();
    await lag.bus.publish('x.change.reconnect.one', 'after');

    expect(seen).toEqual(['after']);
  });

  test('a probe the publisher refuses (its connection still coming back) counts as unheard', async () => {
    const { bus } = laggingBus(0);
    let refusals = 2;
    const publisher: Transport = {
      ...bus,
      publish: (subject, payload) =>
        refusals-- > 0
          ? Promise.reject(
              new TransportUnavailableError({ transport: 'nats', reason: 'redialling' }),
            )
          : bus.publish(subject, payload),
    };
    const held = await subscribed({
      subscriber: bus,
      publisher,
      subject: 'x.change.refused',
      handler: () => undefined,
      pause: noPause,
    });

    expect(refusals).toBeLessThan(0);
    held.unsubscribe();
  });

  test('a subscription never heard is refused, coded, naming the subject and the probes', async () => {
    const { bus } = laggingBus(1_000);
    const refused = await subscribed({
      subscriber: bus,
      publisher: bus,
      subject: 'x.change.never',
      handler: () => undefined,
      polls: 5,
      pause: noPause,
    }).catch((error: unknown) => error);

    expect(refused).toBeUltimateError('X_TRANSPORT_UNAVAILABLE');
    expect((refused as { cause: string }).cause).toContain('x.change.never');
    expect((refused as { cause: string }).cause).toContain('5 probes');
  });

  test('a wildcard is probed on a subject it matches, a literal on itself', () => {
    expect(probeSubjectFor('x.change.posts.*')).toBe('x.change.posts.x-probe');
    expect(probeSubjectFor('x.change.>')).toBe('x.change.x-probe');
    expect(probeSubjectFor('x.room.one')).toBe('x.room.one');
  });
});
