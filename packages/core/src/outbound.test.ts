// `outbound()`'s body and lifetime: the idle watchdog a header-only deadline never gave (measured
// over raw `fetch`: `still-reading-after-300ms`), the cap counted as bytes arrive, the deadline over
// the whole call, and the ambient caller's signal and deadline — a context abort's reason unchanged.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { frozenClock } from './clock';
import { ctxOf, runToCompletion, runWithContext } from './context';
import { isUltimateError, UltimateError } from './errors';
import { outbound } from './outbound';
import { hangingFetch, heldBody, manualTimer, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';

const ONE = { attempts: 1, base: 1, max: 1, jitter: 'none' } as const;
// `outbound`'s overloads pick the answer from `read`; a helper typed `OutboundRequest` matches none.
type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.vendor.test/v1/items',
  vendor: 'vendor',
  dial: 'named',
  deadlineMs: 10_000,
  idleMs: 50,
  retry: ONE,
  ...over,
});

async function caught(work: Promise<unknown>): Promise<UltimateError> {
  try {
    await work;
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the call answered');
}

describe('unit · outbound · the body', () => {
  test('a stalled body is X_OUTBOUND_TIMEOUT at the idle gap, and the stream is cancelled', async () => {
    const timer = manualTimer();
    const body = heldBody();
    body.push('{"partial":');
    const { fetch } = recordingFetch(() => new Response(body.stream));
    const pending = caught(outbound(call(), { fetch, timer }));
    await timer.armedWith(50);
    // The first chunk was read; the second read is the one that waits.
    await Promise.resolve();
    await timer.armedWith(50);
    timer.fire(50);
    const error = await pending;
    expect(error.code).toBe('X_OUTBOUND_TIMEOUT');
    expect(error.meta?.['phase']).toBe('idle');
    expect(timer.armed()).toEqual([]);
  });

  test('a trickling body finishes: each chunk inside the gap resets it', async () => {
    const timer = manualTimer();
    const body = heldBody();
    const { fetch } = recordingFetch(() => new Response(body.stream));
    const pending = outbound(call(), { fetch, timer });
    for (const part of ['{"a"', ':', '1}']) {
      await timer.armedWith(50);
      body.push(part);
    }
    await timer.armedWith(50);
    body.end();
    const answer = await pending;
    expect(answer.json(t.object({ a: t.number }))).toEqual({ a: 1 });
    expect(timer.armed()).toEqual([]);
  });

  test('the cap stops the read mid-chunk: X_OUTBOUND_TOO_LARGE, the source cancelled', async () => {
    const body = heldBody();
    body.push('0123456789');
    body.push('0123456789');
    const { fetch } = recordingFetch(() => new Response(body.stream));
    const error = await caught(outbound(call({ maxBytes: 15 }), { fetch, timer: manualTimer() }));
    expect(error.code).toBe('X_OUTBOUND_TOO_LARGE');
    expect(error.meta?.['maxBytes']).toBe(15);
    expect(body.cancelled()).toBe(true);
  });

  test("read: 'stream' hands the body over under the same watchdog and cap", async () => {
    const timer = manualTimer();
    const body = heldBody();
    const { fetch } = recordingFetch(() => new Response(body.stream));
    const answer = await outbound({ ...call({ maxBytes: 4 }), read: 'stream' }, { fetch, timer });
    const reader = answer.stream.getReader();
    body.push('abc');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('abc');
    body.push('defg');
    const error = await caught(reader.read());
    expect(error.code).toBe('X_OUTBOUND_TOO_LARGE');
    expect(timer.armed()).toEqual([]);
  });

  test('json(schema) refuses a body that does not fit, naming the path', async () => {
    const { fetch } = recordingFetch(() => new Response('{"id":7}'));
    const answer = await outbound(call(), { fetch, timer: manualTimer() });
    expect(answer.status).toBe(200);
    expect(answer.text()).toBe('{"id":7}');
    const error = await caught(
      Promise.resolve().then(() => answer.json(t.object({ id: t.string }))),
    );
    expect(error.code).toBe('X_OUTBOUND_BODY_INVALID');
    expect(error.meta?.['issues']).toEqual(['id']);
    const notJson = await outbound(call(), {
      fetch: recordingFetch(() => new Response('<html>')).fetch,
      timer: manualTimer(),
    });
    const syntax = await caught(Promise.resolve().then(() => notJson.json(t.string)));
    expect(syntax.meta?.['issues']).toEqual(['the body is not JSON']);
  });
});

describe('unit · outbound · lifetime', () => {
  test('no answer by deadlineMs is X_OUTBOUND_TIMEOUT, the deadline phase', async () => {
    const timer = manualTimer();
    // A held monotonic clock: on the platform one, a millisecond spent between the call and its
    // attempt (a cold JIT, a loaded runner) armed 899, and `armedWith(900)` waited forever.
    const now = (): number => 5_000;
    const pending = caught(
      outbound(call({ deadlineMs: 900 }), { fetch: hangingFetch, timer, now }),
    );
    await timer.armedWith(900);
    expect(timer.armed()).toEqual([900]);
    timer.fire(900);
    const error = await pending;
    expect(error.code).toBe('X_OUTBOUND_TIMEOUT');
    expect(error.meta?.['phase']).toBe('deadline');
  });

  test('time spent before the attempt comes off its deadline timer', async () => {
    const timer = manualTimer();
    // The call reads the clock once at its start; the attempt reads it 250 ms later.
    const reads = [5_000, 5_250];
    const now = (): number => reads.shift() ?? 5_250;
    const pending = caught(
      outbound(call({ deadlineMs: 900 }), { fetch: hangingFetch, timer, now }),
    );
    await timer.armedWith(650);
    expect(timer.armed()).toEqual([650]);
    timer.fire(650);
    expect((await pending).meta?.['phase']).toBe('deadline');
  });

  test("the ambient request's abort reaches the call, its reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new UltimateError({ code: 'X_DRAINING', cause: 'draining', fix: 'retry' });
    const ctx = ctxOf({ signal: controller.signal });
    const pending = runWithContext(ctx, () =>
      caught(outbound(call({ retry: undefined }), { fetch: hangingFetch, timer: manualTimer() })),
    );
    await Promise.resolve();
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  test("a transport that rejects with its own AbortError still answers the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new UltimateError({ code: 'X_DRAINING', cause: 'draining', fix: 'retry' });
    const ownAbort: typeof hangingFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    const pending = runWithContext(ctxOf({ signal: controller.signal }), () =>
      caught(outbound(call(), { fetch: ownAbort, timer: manualTimer() })),
    );
    await Promise.resolve();
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  test("the ambient deadline bounds the attempt's timer when it is the tighter", async () => {
    const timer = manualTimer();
    const ctx = ctxOf({ clock: frozenClock(1_000), deadlineAt: 1_400 });
    const pending = runWithContext(ctx, () =>
      caught(outbound(call(), { fetch: hangingFetch, timer, now: () => 5_000 })),
    );
    await new Promise<void>((done) => queueMicrotask(done));
    const armed = timer.armed();
    expect(armed).toHaveLength(1);
    expect(armed).toEqual([400]);
    timer.fire(armed[0] ?? 0);
    // The CALLER's bound fired, not the vendor's: core's X_TIMEOUT, worded by that bound.
    const error = await pending;
    expect([error.code, error.meta?.['bound']]).toEqual(['X_TIMEOUT', 'caller']);
    expect(error.cause).not.toContain('10000');
  });

  test("inside runToCompletion a bound's abort ends the call: the idempotency ceiling holds", async () => {
    const request = new AbortController();
    const ceiling = new AbortController();
    const reason = new UltimateError({ code: 'X_IDEMPOTENCY_RUN_CEILING', cause: 'c', fix: 'f' });
    const ctx = ctxOf({ signal: request.signal });
    const pending = runWithContext(ctx, () =>
      runToCompletion(
        () => caught(outbound(call(), { fetch: hangingFetch, timer: manualTimer() })),
        { signal: ceiling.signal },
      ),
    );
    await Promise.resolve();
    // The request going away is lifted by the escape; the ceiling is the bound that remains.
    request.abort(new UltimateError({ code: 'X_TIMEOUT', cause: 'c', fix: 'f' }));
    await Promise.resolve();
    ceiling.abort(reason);
    expect(await pending).toBe(reason);
  });
});

describe('unit · outbound · a signal of its own', () => {
  test("the call's own signal ends it beside the ambient one, its reason unchanged", async () => {
    const controller = new AbortController();
    const pending = caught(
      outbound(call({ signal: controller.signal }), { fetch: hangingFetch, timer: manualTimer() }),
    );
    await Promise.resolve();
    const reason = new UltimateError({ code: 'X_TIMEOUT', cause: 'fan-out cancelled', fix: 'f' });
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });
});
