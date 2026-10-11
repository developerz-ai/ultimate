// The one numeric option `openNatsClient` accepts, refused before the dial.
//
// Failure case first, and it is the same conditional-spread shape that hid the sync node's four
// socket ceilings: `maxReconnectAttempts` is FORWARDED to the library rather than compared here, so
// it carries no `??` default and `bun run finite-bounds` states in its own header that it cannot see
// an option without one. A `NaN` reconnect budget on a `sync` container's bus client is a reconnect
// policy nobody chose, decided inside a dependency. Screened before the `try`, because the catch
// there re-renders anything it sees as `X_TRANSPORT_UNAVAILABLE` — a bus outage nobody can fix by
// looking at the bus.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { openNatsClient } from './nats-lib-client';
import { NatsTransport } from './nats-transport';

/** Every shape `Number(process.env.NATS_MAX_RECONNECT)` / `parseInt` hands a config reader. */
const NOT_A_BUDGET = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('a nats client opened on a reconnect budget that is not a number', () => {
  test('a non-finite maxReconnectAttempts is refused, and refused before any socket is opened', async () => {
    for (const maxReconnectAttempts of NOT_A_BUDGET) {
      // The URL is a port nothing listens on: the refusal has to arrive without a dial, so this
      // resolves immediately rather than after the library's connect budget. A screen placed after
      // `connect` would make this test hang, then fail with the wrong code.
      let thrown: unknown;
      try {
        await openNatsClient({ url: 'nats://127.0.0.1:1', maxReconnectAttempts });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UltimateError);
      const rendered = thrown instanceof UltimateError ? `${thrown.cause} ${thrown.fix}` : '';
      // Not `X_TRANSPORT_UNAVAILABLE`: a misconfiguration reported as a dead bus sends an operator
      // to the wrong system. The option's own name is the whole value of the refusal.
      expect(rendered).toContain('maxReconnectAttempts');
    }
  });

  test('a non-finite connectTimeoutMs is refused the same way', async () => {
    const thrown = await openNatsClient({
      url: 'nats://127.0.0.1:1',
      connectTimeoutMs: Number.NaN,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown instanceof UltimateError ? `${thrown.cause} ${thrown.fix}` : '').toContain(
      'connectTimeoutMs',
    );
  });
});

// The server that is worse than a dead one: it accepts the socket and never speaks. The library's
// own connect timeout is 20 s, so a `sync` node's 15 s boot wait ran out with no attempt finished
// and a refusal whose `last attempt:` was empty.
describe('a nats client dialling a server that accepts and says nothing', () => {
  test('the dial ends at connectTimeoutMs, coded, naming the server', async () => {
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {} },
    });
    try {
      const startedAt = performance.now();
      const thrown = await openNatsClient({
        url: `nats://127.0.0.1:${silent.port}`,
        connectTimeoutMs: 200,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(thrown).toBeInstanceOf(UltimateError);
      expect(thrown instanceof UltimateError ? thrown.code : '').toBe('X_TRANSPORT_UNAVAILABLE');
      expect(thrown instanceof UltimateError ? thrown.cause : '').toContain(
        `127.0.0.1:${silent.port}`,
      );
    } finally {
      silent.stop(true);
    }
  });

  test('a transport waiting on it is refused with the attempt own reason, not an empty one', async () => {
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {} },
    });
    const transport = new NatsTransport({
      url: `nats://127.0.0.1:${silent.port}`,
      bucket: 'x-test',
      dialTimeoutMs: 150,
      backoff: { baseMs: 10, maxMs: 10, factor: 1, jitter: 'none' },
      onError: () => undefined,
    });
    try {
      const thrown = await transport.connect({ withinMs: 1_000 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const cause = thrown instanceof UltimateError ? thrown.cause : '';
      expect(cause).toContain('within 1000ms');
      expect(cause).toContain('last attempt: ');
      expect(cause.split('last attempt: ')[1]?.length ?? 0).toBeGreaterThan(10);
    } finally {
      await transport.close();
      silent.stop(true);
    }
  });
});
