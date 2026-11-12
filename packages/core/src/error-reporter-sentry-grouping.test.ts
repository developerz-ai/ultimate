// What the monitor SEES of a report: one issue per code, the frames of the throw, and the adopter's
// options (`scrub`-by-value `beforeSend`, `ignore`, `fingerprint`) as the one seam.

import { afterEach, describe, expect, test } from 'bun:test';
import { type ErrorReport, errorReport, resetErrorReporting } from './error-reporter';
import { sentryErrorReporter, sentryEvent } from './error-reporter-sentry';
import type { SentryReporterHooks, SentryReporterOptions } from './error-reporter-sentry-hooks';
import { UltimateError } from './errors';

afterEach(() => {
  resetErrorReporting();
});

const ROOT = process.cwd();
const dsn = 'https://abc123@errors.example.com/42';
const eventId = 'f'.repeat(32);

const coded = (operation: string): ErrorReport =>
  errorReport(new UltimateError({ code: 'X_GROUP_FIXTURE', cause: 'probe', fix: 'x doctor' }), {
    source: 'http',
    scope: { operation },
  });

type Exception = { values: { type: string; stacktrace?: { frames: Record<string, unknown>[] } }[] };

describe('sentryEvent · grouping', () => {
  test('one code raised from five operations is one issue; operation stays the transaction', () => {
    const operations = ['GET /a', 'GET /b', 'POST /c', 'job:sync', 'mcp:tool'];
    const events = operations.map((operation) => sentryEvent(coded(operation), { dsn, eventId }));
    expect(new Set(events.map((event) => JSON.stringify(event['fingerprint']))).size).toBe(1);
    expect(events[0]?.['fingerprint']).toEqual(['X_GROUP_FIXTURE']);
    expect(events.map((event) => event['transaction'])).toEqual(operations);
    expect(events[0]?.['tags']).toMatchObject({ code: 'X_GROUP_FIXTURE', source: 'http' });
  });

  test('X_INTERNAL groups on the application frame', () => {
    const at = (fn: string): ErrorReport => ({
      ...coded('GET /a'),
      code: 'X_INTERNAL',
      stack: `Error\n    at ${fn} (${ROOT}/src/rows.ts:10:9)`,
    });
    expect(sentryEvent(at('loadRow'), { dsn, eventId })['fingerprint']).toEqual([
      'X_INTERNAL',
      'loadRow src/rows.ts',
    ]);
  });
});

describe('sentryEvent · frames', () => {
  test('the exception carries the stack as frames, oldest first; extra.stack stays', () => {
    const report: ErrorReport = {
      ...coded('GET /a'),
      stack: [
        'Error: probe',
        `    at loadRow (${ROOT}/src/rows.ts:10:9)`,
        `    at run (${ROOT}/node_modules/@ultimat3/http/src/serve.ts:4:4)`,
      ].join('\n'),
    };
    const event = sentryEvent(report, { dsn, eventId });
    const [value] = (event['exception'] as Exception).values;
    expect(value?.type).toBe('X_GROUP_FIXTURE');
    expect(value?.stacktrace?.frames.map((frame) => [frame['function'], frame['in_app']])).toEqual([
      ['run', false],
      ['loadRow', true],
    ]);
    expect((event['extra'] as Record<string, unknown>)['stack']).toBe(report.stack);
  });

  test('no stack, or no frame in it, is an exception with no stacktrace key', () => {
    for (const stack of [undefined, 'Error: just a header']) {
      const event = sentryEvent({ ...coded('GET /a'), stack }, { dsn, eventId });
      expect((event['exception'] as Exception).values[0]).not.toHaveProperty('stacktrace');
    }
  });
});

describe('sentryErrorReporter options are the one seam', () => {
  test('SentryReporterHooks is the options minus the wiring: a hooks object spreads in', async () => {
    const bodies: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const hooks: SentryReporterHooks = {
      ignore: (code) => code === 'X_NOISE',
      fingerprint: (report) => ['tenant-a', report.code],
      beforeSend: (event) => ({ ...event, extra: { scrubbed: true } }),
    };
    const options: SentryReporterOptions = { dsn, fetch, ...hooks };
    const reporter = sentryErrorReporter(options);
    reporter.report(coded('GET /a'));
    reporter.report({ ...coded('GET /a'), code: 'X_NOISE' });
    await Bun.sleep(0);
    expect(bodies).toHaveLength(1);
    const event = JSON.parse(bodies[0]?.split('\n')[2] ?? 'null') as Record<string, unknown>;
    expect(event['fingerprint']).toEqual(['tenant-a', 'X_GROUP_FIXTURE']);
    expect(event['extra']).toEqual({ scrubbed: true });
  });
});
