// The outbound audit's findings, each pinned: a spent CALLER deadline is no vendor failure, a
// refusal's detail never keeps raw text, the call's own signal ends a backoff wait, a redirect from
// a named host is screened, and a path never leaks its credential segments.

import { describe, expect, test } from 'bun:test';
import { breaker } from './breaker';
import { frozenClock } from './clock';
import { ctxOf, runWithContext } from './context';
import { isUltimateError, type UltimateError } from './errors';
import { outbound } from './outbound';
import { manualTimer, recordingFetch } from './outbound-fixture';

async function caught(work: Promise<unknown>): Promise<UltimateError> {
  try {
    await work;
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the call answered');
}

const base = { vendor: 'v', dial: 'named' as const, deadlineMs: 60_000 };

describe('unit · outbound · audit', () => {
  test("a spent caller deadline sends nothing, is the caller's X_TIMEOUT, and opens no breaker", async () => {
    const gate = breaker({ name: 'v', failures: 1, cooldownMs: 30_000 });
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const spent = ctxOf({ clock: frozenClock(1_000), deadlineAt: 900 });
    const error = await runWithContext(spent, () =>
      caught(
        outbound(
          { ...base, url: 'https://api.test/x', breaker: gate },
          { fetch, timer: manualTimer() },
        ),
      ),
    );
    expect([error.code, error.meta?.['bound'], calls.length]).toEqual(['X_TIMEOUT', 'caller', 0]);
    expect(error.cause).not.toContain('60000');
    expect(gate.state()).toBe('closed');
  });

  test('a refusal keeps no raw text: a form, an array, HTML and a cut JSON body are dropped', async () => {
    const chunked = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"pad":"${'y'.repeat(1_100)}`));
          controller.enqueue(new TextEncoder().encode('","client_secret":"s3cr3t"}'));
          controller.close();
        },
      });
    const bodies: (() => BodyInit)[] = [
      () => 'client_secret=s3cr3t&code=abc',
      () => '["s3cr3t"]',
      () => '<html>s3cr3t</html>',
      chunked,
    ];
    for (const body of bodies) {
      const { fetch } = recordingFetch(() => new Response(body(), { status: 400 }));
      const error = await caught(
        outbound({ ...base, url: 'https://api.test/x' }, { fetch, timer: manualTimer() }),
      );
      expect([error.code, error.meta?.['detail']]).toEqual(['X_OUTBOUND_REFUSED', '']);
    }
  });

  test("the call's own signal ends a Retry-After wait at once", async () => {
    const controller = new AbortController();
    const reason = new TypeError('cancelled by the fan-out');
    const { fetch } = recordingFetch(() => {
      // A macrotask: it lands once this attempt has settled, inside the Retry-After wait.
      setTimeout(() => controller.abort(reason), 0);
      return new Response('', { status: 429, headers: { 'retry-after': '30' } });
    });
    const settled = await outbound(
      { ...base, url: 'https://api.test/x', signal: controller.signal },
      { fetch, timer: manualTimer() },
    ).then(
      () => 'answered',
      (error: unknown) => error,
    );
    expect(settled).toBe(reason);
  });

  test('a redirect from a NAMED host is screened: a hop to the metadata address is refused', async () => {
    const { fetch, calls } = recordingFetch(
      () =>
        new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    );
    const error = await caught(
      outbound(
        { ...base, url: 'https://api.test/x', redirect: 'follow', headers: { 'x-api-key': 'k' } },
        { fetch, timer: manualTimer(), env: { ULTIMATE_ENV: 'development' } },
      ),
    );
    expect(error.code).toBe('X_OUTBOUND_HOST_BLOCKED');
    expect(calls).toHaveLength(1);
  });

  test('a path keeps its first segment and the length of the rest: a webhook token never shows', async () => {
    const { fetch } = recordingFetch(() => new Response('', { status: 404 }));
    const error = await caught(
      outbound(
        { ...base, url: 'https://hooks.slack.test/services/T000/B000/SECRETTOKEN' },
        { fetch, timer: manualTimer() },
      ),
    );
    const printed = JSON.stringify({ cause: error.cause, fix: error.fix, meta: error.meta });
    expect(printed).not.toContain('SECRETTOKEN');
    expect(error.meta?.['path']).toBe('/services/…(21 chars)');
  });
});
