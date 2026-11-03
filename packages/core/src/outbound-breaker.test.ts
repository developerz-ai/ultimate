// `outbound({ breaker })` records ONCE per call, after the retries: a 503 retried away inside one
// call is a success, an exhausted transport failure is one failure, an open breaker sends nothing,
// and a caller going away gives the probe back and counts nothing.

import { describe, expect, test } from 'bun:test';
import { breaker } from './breaker';
import { ctxOf, runWithContext } from './context';
import { isUltimateError, UltimateError } from './errors';
import { outbound } from './outbound';
import { hangingFetch, manualTimer, recordedSleep, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';

function fakeClock(): { monotonic: () => number; advance: (ms: number) => void } {
  let at = 0;
  return { monotonic: () => at, advance: (ms) => (at += ms) };
}

const gateWith = (clock = fakeClock()) =>
  breaker({ name: 'vendor', failures: 1, cooldownMs: 30_000, clock });

// `outbound`'s overloads pick the answer from `read`; a helper typed `OutboundRequest` matches none.
type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (gate: OutboundRequest['breaker']): BytesCall => ({
  url: 'https://api.vendor.test/v1',
  vendor: 'vendor',
  dial: 'named',
  deadlineMs: 60_000,
  breaker: gate,
});

const code = (error: unknown): string => (isUltimateError(error) ? error.code : 'uncoded');

describe('unit · outbound · breaker', () => {
  test('a 503 then a 200 inside one call records a success', async () => {
    const gate = gateWith();
    const { fetch } = recordingFetch((_call, n) =>
      n === 1 ? new Response('', { status: 503 }) : new Response('ok'),
    );
    await outbound(call(gate), { fetch, ...recordedSleep(), timer: manualTimer() });
    expect([gate.state(), gate.failures()]).toEqual(['closed', 0]);
  });

  test('every attempt failing is ONE failure; then the open breaker sends nothing', async () => {
    const gate = gateWith();
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 503 }));
    const deps = { fetch, ...recordedSleep(), timer: manualTimer() };
    expect(code(await outbound(call(gate), deps).catch((e: unknown) => e))).toBe(
      'X_OUTBOUND_UNAVAILABLE',
    );
    expect([gate.state(), calls.length]).toEqual(['open', 3]);
    expect(code(await outbound(call(gate), deps).catch((e: unknown) => e))).toBe('X_BREAKER_OPEN');
    expect(calls).toHaveLength(3);
  });

  test('a refusal is the vendor answering: X_OUTBOUND_REFUSED does not open it', async () => {
    const gate = gateWith();
    const { fetch } = recordingFetch(() => new Response('bad', { status: 400 }));
    await outbound(call(gate), { fetch, timer: manualTimer() }).catch(() => undefined);
    expect(gate.state()).toBe('closed');
  });

  test('a caller abort records nothing and gives the probe back', async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    gate.failed(gate.admit());
    clock.advance(30_000);
    const controller = new AbortController();
    const pending = runWithContext(ctxOf({ signal: controller.signal }), () =>
      outbound(call(gate), { fetch: hangingFetch, timer: manualTimer() }).catch((e: unknown) => e),
    );
    await Promise.resolve();
    controller.abort(new UltimateError({ code: 'X_TIMEOUT', cause: 'c', fix: 'f' }));
    expect(code(await pending)).toBe('X_TIMEOUT');
    expect([gate.state(), gate.failures(), gate.admit()?.probe]).toEqual(['half-open', 1, true]);
  });
});
