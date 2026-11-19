// The Sentry transport READS the monitor's answer: a refused DSN or a rate limit is said once per
// status rather than dropping every event in silence, a 429 pauses sends for its stated delay, and
// every answer's body is released. A DSN refusal never echoes the credential a DSN may carry.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { errorReport } from './error-reporter';
import { parseSentryDsn, sentryErrorReporter } from './error-reporter-sentry';
import { UltimateError } from './errors';
import { installLogSink } from './logger';

afterEach(() => {
  jest.useRealTimers();
});

const dsn = 'https://abc123@errors.example.com/42';
const failure = () =>
  errorReport(new UltimateError({ code: 'X_SEND_FIXTURE', cause: 'c', fix: 'f' }), {
    source: 'http',
  });

/** Lets the fire-and-forget delivery's `.then` run. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function monitor(answer: () => Response) {
  let sent = 0;
  const fetch = (async () => {
    sent += 1;
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent: () => sent };
}

async function warnings(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const release = installLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  try {
    await run();
  } finally {
    release();
  }
  return lines.filter((line) => line['level'] === 'warn');
}

describe('sentryErrorReporter · the answer', () => {
  test('a non-2xx answer writes one warn line per status', async () => {
    let status = 403;
    const { fetch, sent } = monitor(() => new Response('denied', { status }));
    const reporter = sentryErrorReporter({ dsn, fetch });
    const lines = await warnings(async () => {
      for (let i = 0; i < 50; i += 1) reporter.report(failure());
      await settled();
      status = 401;
      for (let i = 0; i < 5; i += 1) reporter.report(failure());
      await settled();
    });
    expect(sent()).toBe(55);
    expect(lines.map((line) => line['status'])).toEqual([403, 401]);
    expect(JSON.stringify(lines)).not.toContain('abc123');
  });

  test('a 429 pauses sends for its Retry-After, then they resume', async () => {
    jest.useFakeTimers();
    let limited = true;
    const { fetch, sent } = monitor(() =>
      limited
        ? new Response('', { status: 429, headers: { 'retry-after': '60' } })
        : new Response('', { status: 200 }),
    );
    const reporter = sentryErrorReporter({ dsn, fetch });
    const lines = await warnings(async () => {
      reporter.report(failure());
      await settled();
      for (let i = 0; i < 20; i += 1) reporter.report(failure());
      await settled();
    });
    expect(sent()).toBe(1);
    expect(lines.map((line) => [line['status'], line['retryAfterSeconds']])).toEqual([[429, 60]]);
    limited = false;
    jest.advanceTimersByTime(60_001);
    reporter.report(failure());
    await settled();
    expect(sent()).toBe(2);
  });

  test("every answer's body is cancelled, never left to the collector", async () => {
    let cancelled = 0;
    const body = () =>
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{}'));
        },
        cancel() {
          cancelled += 1;
        },
      });
    const { fetch } = monitor(() => new Response(body(), { status: 200 }));
    const reporter = sentryErrorReporter({ dsn, fetch });
    reporter.report(failure());
    reporter.report(failure());
    await settled();
    expect(cancelled).toBe(2);
  });
});

describe('parseSentryDsn · a refusal never echoes a credential', () => {
  test.each(['https://pub:hunter2-secret@errors.example.com', 'https://pub:hunter2-secret@[bad'])(
    '%s',
    (value) => {
      let printed = '';
      try {
        parseSentryDsn(value);
      } catch (thrown) {
        printed = JSON.stringify(thrown instanceof UltimateError ? thrown.toJSON() : thrown);
      }
      expect(printed).toContain('X_ERROR_REPORTER_DSN_INVALID');
      expect(printed).not.toContain('hunter2-secret');
    },
  );
});
