// The error-reporter suite over core's two reporters — the memory sink and the Sentry envelope
// transport over a recording `fetch` — and the proof it can fail: a hand-rolled transport that
// serialises the report as it stands, so a bigint throws into the caller and a password leaves.

import { describe, expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import { memoryErrorReporter, sentryErrorReporter } from '@ultimat3/core';
import type { ErrorReporter } from '@ultimat3/core/adapter';
import type { ErrorReporterSubject } from './error-reporter-conformance';
import { ERROR_REPORTER_CHECKS, errorReporterConformance } from './error-reporter-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory error reporter'), () => {
  behavesLike(errorReporterConformance, () => {
    const reporter = memoryErrorReporter();
    // `Bun.inspect`: a held report keeps its `meta` whole, cycles and bigints included.
    return { reporter, delivered: () => reporter.events.map((event) => Bun.inspect(event)) };
  });
});

/** The Sentry transport, every envelope it POSTs recorded and answered 200. */
function sentrySubject(): ErrorReporterSubject {
  const bodies: string[] = [];
  const reporter = sentryErrorReporter({
    dsn: 'https://publickey@monitor.test/42',
    // Bun's `fetch` carries `preconnect` beside the call: a bare arrow is not `typeof fetch`.
    fetch: Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        bodies.push(String(init?.body ?? ''));
        return new Response('{}');
      },
      { preconnect: (): void => {} },
    ),
  });
  return { reporter, delivered: () => bodies };
}

describe(testName('unit', 'the Sentry envelope reporter over a recorded fetch'), () => {
  behavesLike(errorReporterConformance, sentrySubject);
});

/** `JSON.stringify(report)` as it stands: a bigint throws, and `meta.password` goes out whole. */
function naive(): ErrorReporterSubject {
  const sent: string[] = [];
  const reporter: ErrorReporter = {
    report(report: ErrorReport): void {
      sent.push(JSON.stringify({ ...report, error: undefined }));
    },
  };
  return { reporter, delivered: () => sent };
}

const check = (prefix: string) => {
  const found = ERROR_REPORTER_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no error-reporter check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a reporter that breaks the contract fails conformance'), () => {
  test('a naive serialiser delivers, then throws on a bigint and leaks the secret', async () => {
    await check('every report is delivered once').run(naive());
    await expect(check('a meta holding a bigint').run(naive())).rejects.toThrow();
    await expect(
      check('a reporter that is not a marked local sink').run(naive()),
    ).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = ERROR_REPORTER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
