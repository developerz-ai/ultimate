// The wire format, pinned as a unit test rather than discovered against a live monitor. The
// preload seals `fetch`, so the transport takes one — which is also how the envelope it sends is
// asserted without a network.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { configureErrorReporting, errorReport, resetErrorReporting } from './error-reporter';
import {
  ErrorReporterDsnInvalidError,
  parseSentryDsn,
  sentryEnvelope,
  sentryErrorReporter,
} from './error-reporter-sentry';
import { UltimateError } from './errors';

afterEach(() => {
  resetErrorReporting();
});

const report = () => {
  configureErrorReporting({
    clock: frozenClock(new Date('2026-08-11T00:00:00Z')),
    release: 'build-abc',
    environment: 'production',
  });
  return errorReport(
    new UltimateError({
      // A code THIS FILE owns and no package registers. `X_DB_DRIFT` was order-dependent: its
      // title is registry-owned, so it read as the derived fallback when only core was loaded and
      // as @ultimat3/db's real title once anything pulled that package in — the test passed alone
      // and failed in the suite. The envelope's shape is what is under test, not which codes exist.
      code: 'X_ENVELOPE_FIXTURE',
      cause: 'table "posts" has an undeclared column',
      fix: 'x db gen "add publish_at"',
      meta: { table: 'posts' },
    }),
    { source: 'http', scope: { requestId: 'req-1', traceId: 'a'.repeat(32), role: 'web' } },
  );
};

describe('parseSentryDsn', () => {
  test('derives the envelope endpoint from the DSN alone', () => {
    const dsn = parseSentryDsn('https://abc123@errors.example.com/42');
    expect(dsn.publicKey).toBe('abc123');
    expect(dsn.projectId).toBe('42');
    expect(dsn.envelopeUrl).toBe('https://errors.example.com/api/42/envelope/');
  });

  test('keeps a path prefix, which is what a self-hosted monitor behind a sub-path needs', () => {
    const dsn = parseSentryDsn('https://key@example.com:9000/monitor/7');
    expect(dsn.envelopeUrl).toBe('https://example.com:9000/monitor/api/7/envelope/');
  });

  test('a DSN with no public key is refused at wiring time, with a runnable fix', () => {
    let caught: unknown;
    try {
      parseSentryDsn('https://errors.example.com/42');
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ErrorReporterDsnInvalidError);
    expect((caught as ErrorReporterDsnInvalidError).code).toBe('X_ERROR_REPORTER_DSN_INVALID');
    expect((caught as ErrorReporterDsnInvalidError).fix).toContain('x env check');
  });

  test('a value that is not a URL at all is the same refusal', () => {
    expect(() => parseSentryDsn('not-a-dsn')).toThrow(ErrorReporterDsnInvalidError);
  });
});

describe('sentryEnvelope', () => {
  test('three newline-delimited lines: header, item, payload', () => {
    const envelope = sentryEnvelope(report(), {
      dsn: 'https://abc123@errors.example.com/42',
      eventId: 'f'.repeat(32),
    });
    const [header, item, payload] = envelope.split('\n');

    expect(JSON.parse(header as string)).toEqual({
      event_id: 'f'.repeat(32),
      sent_at: '2026-08-11T00:00:00.000Z',
      dsn: 'https://abc123@errors.example.com/42',
    });
    const itemHeader = JSON.parse(item as string) as { type: string; length: number };
    expect(itemHeader.type).toBe('event');
    // The declared length is BYTES, so a multi-byte cause cannot desynchronise the stream.
    expect(itemHeader.length).toBe(new TextEncoder().encode(payload as string).length);
  });

  test('the payload carries the contract, the release and the trace, with bounded tags', () => {
    const envelope = sentryEnvelope(report(), {
      dsn: 'https://abc123@errors.example.com/42',
      eventId: 'f'.repeat(32),
    });
    const payload = JSON.parse(envelope.split('\n')[2] as string) as Record<string, unknown>;

    expect(payload['release']).toBe('build-abc');
    expect(payload['environment']).toBe('production');
    expect(payload['timestamp']).toBe(new Date('2026-08-11T00:00:00Z').getTime() / 1000);
    // Tags are facets: bounded values only, the same rule metric labels follow.
    expect(payload['tags']).toMatchObject({
      code: 'X_ENVELOPE_FIXTURE',
      source: 'http',
      role: 'web',
    });
    expect((payload['extra'] as Record<string, unknown>)['fix']).toBe('x db gen "add publish_at"');
    expect((payload['extra'] as Record<string, unknown>)['requestId']).toBe('req-1');
    expect(payload['contexts']).toEqual({ trace: { trace_id: 'a'.repeat(32) } });
    expect(payload['exception']).toEqual({
      values: [
        {
          type: 'X_ENVELOPE_FIXTURE',
          value: 'envelope fixture — table "posts" has an undeclared column',
        },
      ],
    });
  });
});

describe('sentryErrorReporter', () => {
  test('POSTs one envelope with the protocol auth header, and never awaits it', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reporter = sentryErrorReporter({
      dsn: 'https://abc123@errors.example.com/42',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('', { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });

    reporter.report(report());
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://errors.example.com/api/42/envelope/');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-sentry-auth']).toContain('sentry_version=7');
    expect(headers['x-sentry-auth']).toContain('sentry_key=abc123');
    expect(headers['content-type']).toBe('application/x-sentry-envelope');
  });

  test('a rejection that fights being READ raises no unhandled rejection', async () => {
    // Fire-and-forget delivery: the `.catch` is the only thing between a monitor outage and an
    // unhandled rejection, which takes the process with it on Bun. Rendering the rejection with
    // `failure instanceof Error ? failure.message : String(failure)` threw inside that catch.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const reporter = sentryErrorReporter({
        dsn: 'https://abc123@errors.example.com/42',
        fetch: (() =>
          Promise.reject(
            new Proxy(new Error('ECONNREFUSED'), {
              getPrototypeOf(): never {
                throw new TypeError('proxy trap');
              },
            }),
          )) as unknown as typeof globalThis.fetch,
      });
      reporter.report(report());
      // Two turns: one for the rejection, one for the `.catch` handler's own outcome.
      await Bun.sleep(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test('a monitor that refuses the connection never reaches the caller', () => {
    const reporter = sentryErrorReporter({
      dsn: 'https://abc123@errors.example.com/42',
      fetch: (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch,
    });
    expect(() => {
      reporter.report(report());
    }).not.toThrow();
  });
});
