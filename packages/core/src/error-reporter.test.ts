// The seam that was declared and never plugged in. These pin the two things a monitor is useless
// without: the framework's error contract arrives intact, and reporting can never become the
// second failure.

import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from './actor';
import { frozenClock } from './clock';
import { createContext, runWithContext } from './context';
import {
  configureErrorReporting,
  type ErrorReport,
  errorReport,
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from './error-reporter';
import { InternalError, UltimateError } from './errors';

afterEach(() => {
  resetErrorReporting();
});

const install = () => {
  const reporter = memoryErrorReporter();
  configureErrorReporting({ reporter, clock: frozenClock(new Date('2026-08-11T00:00:00Z')) });
  return reporter;
};

describe('reportError', () => {
  test('carries the error contract verbatim — code, cause, fix and docs', () => {
    const reporter = install();
    reportError(
      new UltimateError({
        code: 'X_DB_DRIFT',
        cause: 'table "posts" has an undeclared column',
        fix: 'x db gen "add publish_at"',
        meta: { table: 'posts' },
      }),
      { source: 'http' },
    );

    const event = reporter.events[0] as ErrorReport;
    expect(event.code).toBe('X_DB_DRIFT');
    expect(event.cause).toBe('table "posts" has an undeclared column');
    // The whole reason a report is not a message string: the fix is what the paged human runs.
    expect(event.fix).toBe('x db gen "add publish_at"');
    expect(event.docs).toBe('https://ultimate.dev/errors/X_DB_DRIFT');
    expect(event.meta).toEqual({ table: 'posts' });
    expect(event.severity).toBe('error');
    expect(event.source).toBe('http');
    expect(event.at).toBe(new Date('2026-08-11T00:00:00Z').getTime());
  });

  test('an accidental TypeError still arrives with a code, a fix and its OWN stack', () => {
    const reporter = install();
    const thrown = new TypeError('undefined is not a function');
    reportError(thrown, { source: 'job' });

    const event = reporter.events[0] as ErrorReport;
    expect(event.code).toBe('X_INTERNAL');
    expect(event.cause).toBe('TypeError: undefined is not a function');
    expect(event.fix.length).toBeGreaterThan(0);
    // The wrapper is constructed inside `errorReport`, so its stack points at the reporter rather
    // than at the throw. A report whose stack names the instrumentation is worthless.
    expect(event.stack).toBe(thrown.stack);
    expect(event.error).toBe(thrown);
  });

  test('the ambient context fills the scope the caller did not name', () => {
    const reporter = install();
    const ctx = createContext({
      requestId: 'req-1',
      traceId: 'trace-1',
      role: 'worker',
      buildId: 'build-abc',
      actor: userActor({ id: 'user-7' }),
    });
    runWithContext(ctx, () => {
      reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'job' });
    });

    const event = reporter.events[0] as ErrorReport;
    expect(event.scope.requestId).toBe('req-1');
    expect(event.scope.traceId).toBe('trace-1');
    expect(event.scope.role).toBe('worker');
    expect(event.scope.actorId).toBe('user-7');
    // No configured release: the context's build id is the deploy's id, not a second one.
    expect(event.release).toBe('build-abc');
  });

  test('an explicit scope wins over the ambient one', () => {
    const reporter = install();
    runWithContext(createContext({ requestId: 'ambient' }), () => {
      reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), {
        source: 'http',
        severity: 'warning',
        scope: { requestId: 'explicit', operation: 'GET /posts/:id' },
      });
    });

    const event = reporter.events[0] as ErrorReport;
    expect(event.scope.requestId).toBe('explicit');
    expect(event.scope.operation).toBe('GET /posts/:id');
    expect(event.severity).toBe('warning');
  });

  test('a configured release is the one every report carries', () => {
    const reporter = install();
    configureErrorReporting({ release: 'build-from-serve' });
    runWithContext(createContext({ buildId: 'build-from-ctx' }), () => {
      reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'http' });
    });

    expect((reporter.events[0] as ErrorReport).release).toBe('build-from-serve');
  });

  test('a reporter that throws never reaches the caller', () => {
    configureErrorReporting({
      reporter: {
        report(): void {
          throw new Error('monitor is down');
        },
      },
    });

    expect(() =>
      reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'http' }),
    ).not.toThrow();
  });

  test('a reporter that throws a HOSTILE value never reaches the caller either', () => {
    // The catch that makes "never throws" true rendered the failure with
    // `failure instanceof Error ? failure.message : String(failure)` — two property operations on
    // a value from outside the framework, so the swallowed failure escaped through its own log
    // line and became the second failure this function exists to prevent.
    configureErrorReporting({
      reporter: {
        report(): never {
          throw new Proxy(new Error('monitor is down'), {
            getPrototypeOf(): never {
              throw new TypeError('proxy trap');
            },
          });
        },
      },
    });

    expect(() =>
      reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'http' }),
    ).not.toThrow();
  });

  test('a thrown value whose stack cannot be read still produces a report', () => {
    const reporter = install();
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new TypeError('get trap');
        },
        has(): never {
          throw new TypeError('has trap');
        },
        getPrototypeOf(): never {
          throw new TypeError('getPrototypeOf trap');
        },
      },
    );

    expect(() => reportError(hostile, { source: 'job' })).not.toThrow();
    const report = reporter.events[0] as ErrorReport;
    expect(report.code).toBe('X_INTERNAL');
    expect(typeof report.stack === 'string' || report.stack === undefined).toBe(true);
  });

  test('enabled: false silences it, and the default reporter is the no-op', () => {
    const reporter = install();
    configureErrorReporting({ enabled: false });
    reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'http' });
    expect(reporter.events).toHaveLength(0);

    resetErrorReporting();
    expect(() => noopErrorReporter.report(errorReport('nope', { source: 'cli' }))).not.toThrow();
  });
});

describe('memoryErrorReporter', () => {
  test('reset drops what it collected', () => {
    const reporter = install();
    reportError(new InternalError({ cause: 'boom', fix: 'x doctor --json' }), { source: 'cli' });
    expect(reporter.events).toHaveLength(1);
    reporter.reset();
    expect(reporter.events).toHaveLength(0);
  });
});
