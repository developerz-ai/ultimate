// `outbound({ breaker })` records ONCE per call, after the retries: a 503 retried away inside one
// call is a success, an exhausted transport failure is one failure, an open breaker sends nothing,
// and a caller going away gives the probe back and counts nothing.

import { describe, expect, test } from 'bun:test';
import { breaker } from './breaker';
import { RETRY_BURST } from './breaker-retry-budget';
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

  test('a partial outage: retries stay within 20% of calls (plus the burst) per breaker key', async () => {
    // Never opens: a vendor failing some calls, not all, is the case the breaker cannot see.
    const gate = breaker({ name: 'flaky', failures: 1_000, cooldownMs: 30_000 });
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 503 }));
    const deps = { fetch, ...recordedSleep(), timer: manualTimer() };
    const codes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      codes.add(code(await outbound(call(gate), deps).catch((e: unknown) => e)));
    }
    // Without the ratio: 300 sends, three per call. A refused retry is the last answer, unchanged.
    expect(calls.length).toBeLessThanOrEqual(100 + 20 + RETRY_BURST);
    expect([...codes]).toEqual(['X_OUTBOUND_UNAVAILABLE']);
  });

  test('a drained key earns a retry back with every five calls it sends', async () => {
    const gate = breaker({ name: 'recovering', failures: 1_000, cooldownMs: 30_000 });
    let failing = true;
    const { fetch } = recordingFetch(() =>
      failing ? new Response('', { status: 503 }) : new Response('ok'),
    );
    const deps = { fetch, ...recordedSleep(), timer: manualTimer() };
    for (let i = 0; i < 40; i += 1) await outbound(call(gate), deps).catch(() => undefined);
    // Drained: a 503 is answered as it is, no retry.
    expect(code(await outbound(call(gate), deps).catch((e: unknown) => e))).toBe(
      'X_OUTBOUND_UNAVAILABLE',
    );
    failing = false;
    for (let i = 0; i < 5; i += 1) await outbound(call(gate), deps);
    let sent = 0;
    const { fetch: flaky } = recordingFetch((_call, n) => {
      sent = n;
      return n === 1 ? new Response('', { status: 503 }) : new Response('ok');
    });
    const answer = await outbound(call(gate), { ...deps, fetch: flaky });
    expect([answer.status, sent]).toEqual([200, 2]);
  });

  test('a call with no breaker keeps its whole retry policy', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('', { status: 503 }));
    const deps = { fetch, ...recordedSleep(), timer: manualTimer() };
    for (let i = 0; i < 20; i += 1) await outbound(call(undefined), deps).catch(() => undefined);
    expect(calls).toHaveLength(60);
  });
});
