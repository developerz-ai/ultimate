// The wire format, pinned as a unit test rather than discovered against a live monitor. The
// preload seals `fetch`, so the transport takes one — which is also how the envelope it sends is
// asserted without a network.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { errorFingerprint } from './error-fingerprint';
import { configureErrorReporting, errorReport, resetErrorReporting } from './error-reporter';
import {
  ErrorReporterDsnInvalidError,
  parseSentryDsn,
  sentryEnvelope,
  sentryErrorReporter,
} from './error-reporter-sentry';
import { UltimateError } from './errors';
import { REDACTED } from './logger';

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

  test('the envelope names its group: the fingerprint is errorFingerprint(report)', () => {
    const built = report();
    const envelope = sentryEnvelope(built, {
      dsn: 'https://abc123@errors.example.com/42',
      eventId: 'f'.repeat(32),
    });
    const payload = JSON.parse(envelope.split('\n')[2] as string) as Record<string, unknown>;
    expect(payload['fingerprint']).toEqual([errorFingerprint(built)]);
  });
});

describe("sentryEnvelope · meta is the caller's, so it is rendered, nested and scrubbed", () => {
  const envelopeOf = (
    meta: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> => {
    configureErrorReporting({ clock: frozenClock(new Date('2026-08-11T00:00:00Z')) });
    const built = errorReport(
      new UltimateError({ code: 'X_ENVELOPE_FIXTURE', cause: 'c', fix: 'the real fix', meta }),
      { source: 'http', scope: { requestId: 'req-1', ...(extra === undefined ? {} : { extra }) } },
    );
    const envelope = sentryEnvelope(built, {
      dsn: 'https://k@h.example/1',
      eventId: 'f'.repeat(32),
    });
    const payload = JSON.parse(envelope.split('\n')[2] as string) as Record<string, unknown>;
    return payload['extra'] as Record<string, unknown>;
  };

  test('a bigint or a cycle in meta still produces an envelope — the error is reported', () => {
    // `JSON.stringify` raises on both, so the one error whose meta held an id as a bigint was the
    // one error the monitor never heard about.
    const cycle: Record<string, unknown> = { name: 'loop' };
    cycle['self'] = cycle;
    const extra = envelopeOf({ rowId: 10n ** 20n, cycle });
    expect((extra['meta'] as Record<string, unknown>)['rowId']).toBe('100000000000000000000n');
    expect(extra['fix']).toBe('the real fix');
  });

  test("meta cannot overwrite the framework's own keys: it lives under extra.meta", () => {
    const extra = envelopeOf({
      fix: 'rm -rf /',
      stack: 'forged',
      requestId: 'forged',
      table: 'posts',
    });
    expect(extra['fix']).toBe('the real fix');
    expect(extra['requestId']).toBe('req-1');
    expect(extra['stack']).not.toBe('forged');
    expect(extra['table']).toBeUndefined();
    expect((extra['meta'] as Record<string, unknown>)['table']).toBe('posts');
  });

  test('scope.extra stays beside the contract and still cannot replace it', () => {
    const extra = envelopeOf({}, { fix: 'forged', tenant: 'org-3', big: 5n });
    expect(extra['fix']).toBe('the real fix');
    expect(extra['tenant']).toBe('org-3');
    expect(extra['big']).toBe('5n');
  });

  test('a credential under a redacted key never reaches the monitor', () => {
    const extra = envelopeOf(
      { password: 'hunter2', nested: { resetToken: 'tok_live' } },
      { authorization: 'Bearer abc' },
    );
    const text = JSON.stringify(extra);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('tok_live');
    expect(text).not.toContain('Bearer abc');
    expect((extra['meta'] as Record<string, unknown>)['password']).toBe(REDACTED);
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

/**
 * The hooks an adopter wrote 881 lines around: scrub by value, drop by code, group their own way,
 * sample. Each is a function of the report or the event — no vendor SDK, no global.
 */
describe('sentryErrorReporter hooks', () => {
  const capture = () => {
    const bodies: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { bodies, fetch };
  };
  const dsn = 'https://abc123@errors.example.com/42';
  const eventOf = (body: string | undefined): Record<string, unknown> =>
    JSON.parse(body?.split('\n')[2] ?? 'null') as Record<string, unknown>;

  test('beforeSend returning null sends nothing', async () => {
    const { bodies, fetch } = capture();
    const reporter = sentryErrorReporter({ dsn, fetch, beforeSend: () => null });
    reporter.report(report());
    await Promise.resolve();
    expect(bodies).toHaveLength(0);
  });

  test('beforeSend may rewrite the event, and the envelope carries the rewrite', async () => {
    const { bodies, fetch } = capture();
    const reporter = sentryErrorReporter({
      dsn,
      fetch,
      beforeSend: (event) => ({ ...event, extra: { scrubbed: true } }),
    });
    reporter.report(report());
    await Promise.resolve();
    expect(eventOf(bodies[0])['extra']).toEqual({ scrubbed: true });
    // The item header's `length` is the REWRITTEN payload's, or the monitor rejects the envelope.
    const [, item, payload] = (bodies[0] ?? '').split('\n');
    const declared = (JSON.parse(item ?? '{}') as { length?: number }).length;
    expect(declared).toBe(new TextEncoder().encode(payload).length);
  });

  test('a beforeSend that throws drops the event rather than sending it unscrubbed', async () => {
    const { bodies, fetch } = capture();
    const reporter = sentryErrorReporter({
      dsn,
      fetch,
      beforeSend: () => {
        throw new UltimateError({ code: 'X_ENVELOPE_FIXTURE', cause: 'scrubber bug', fix: 'none' });
      },
    });
    expect(() => reporter.report(report())).not.toThrow();
    await Promise.resolve();
    expect(bodies).toHaveLength(0);
  });

  // A hook's output is the adopter's value, so serialising it can throw — a `bigint`, a cycle. That
  // threw out of `report()`, which runs inside every failure path's catch.
  test('an event beforeSend made unserialisable is dropped, never thrown', async () => {
    const { bodies, fetch } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const extra of [{ big: 1n }, cyclic]) {
      const reporter = sentryErrorReporter({
        dsn,
        fetch,
        beforeSend: (event) => ({ ...event, extra }),
      });
      expect(() => reporter.report(report())).not.toThrow();
    }
    const grouped = sentryErrorReporter({
      dsn,
      fetch,
      fingerprint: () => [1n as unknown as string],
    });
    expect(() => grouped.report(report())).not.toThrow();
    await Promise.resolve();
    expect(bodies).toHaveLength(0);
  });

  test('ignore(code) drops that code and only that code', async () => {
    const { bodies, fetch } = capture();
    const seen: string[] = [];
    const reporter = sentryErrorReporter({
      dsn,
      fetch,
      ignore: (code) => {
        seen.push(code);
        return code === 'X_ENVELOPE_FIXTURE';
      },
    });
    reporter.report(report());
    await Promise.resolve();
    expect(seen).toEqual(['X_ENVELOPE_FIXTURE']);
    expect(bodies).toHaveLength(0);
    const keep = sentryErrorReporter({ dsn, fetch, ignore: (code) => code === 'X_OTHER' });
    keep.report(report());
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
  });

  test('fingerprint lands in the envelope in place of the default', async () => {
    const { bodies, fetch } = capture();
    const reporter = sentryErrorReporter({
      dsn,
      fetch,
      fingerprint: (event) => ['tenant-a', event.code],
    });
    reporter.report(report());
    await Promise.resolve();
    expect(eventOf(bodies[0])['fingerprint']).toEqual(['tenant-a', 'X_ENVELOPE_FIXTURE']);
  });

  test('sampleRate 0 sends nothing; 1 sends everything; between, the roll decides', async () => {
    const { bodies, fetch } = capture();
    sentryErrorReporter({ dsn, fetch, sampleRate: 0 }).report(report());
    await Promise.resolve();
    expect(bodies).toHaveLength(0);
    sentryErrorReporter({ dsn, fetch, sampleRate: 1 }).report(report());
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
    const half = (roll: number) =>
      sentryErrorReporter({ dsn, fetch, sampleRate: 0.5, random: () => roll });
    half(0.49).report(report());
    half(0.5).report(report());
    await Promise.resolve();
    expect(bodies).toHaveLength(2);
  });

  test('a sampleRate outside 0..1 is refused at wiring time', () => {
    for (const sampleRate of [-0.1, 1.5, Number.NaN]) {
      expect(() => sentryErrorReporter({ dsn, sampleRate })).toThrow(
        expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
      );
    }
  });
});
