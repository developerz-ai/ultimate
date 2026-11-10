// Several reporters behind the ONE seam: every member receives every report, one that throws costs
// only itself, a chain of chains is one flat list, and the boot can swap its own member out.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ErrorReport,
  type ErrorReporter,
  installErrorReporter,
  installedErrorReporter,
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from './error-reporter';
import { chainErrorReporters, errorReportersOf } from './error-reporter-chain';
import { InternalError } from './errors';

afterEach(() => resetErrorReporting());

const boom = (): InternalError => new InternalError({ cause: 'boom', fix: 'x doctor --json' });

describe('chainErrorReporters', () => {
  test('every member receives the same report, in order', () => {
    const order: string[] = [];
    const first = memoryErrorReporter();
    const second = memoryErrorReporter();
    const tagged = (name: string, into: ErrorReporter): ErrorReporter => ({
      report(event) {
        order.push(name);
        into.report(event);
      },
    });
    installErrorReporter(chainErrorReporters(tagged('a', first), tagged('b', second)));
    reportError(boom(), { source: 'http' });
    expect(order).toEqual(['a', 'b']);
    expect(first.events[0]).toBe(second.events[0] as ErrorReport);
  });

  test('a member that throws costs itself, never the members after it', () => {
    const after = memoryErrorReporter();
    const throwing: ErrorReporter = {
      report() {
        throw new InternalError({ cause: 'vendor down', fix: 'x doctor --json' });
      },
    };
    installErrorReporter(chainErrorReporters(throwing, after));
    reportError(boom(), { source: 'job' });
    expect(after.events).toHaveLength(1);
  });

  test('a chain of chains is one flat list: no member twice, no no-op', () => {
    const a = memoryErrorReporter();
    const b = memoryErrorReporter();
    const chained = chainErrorReporters(chainErrorReporters(a, noopErrorReporter), b, a);
    expect(errorReportersOf(chained)).toEqual([a, b]);
    chained.report(
      (() => {
        const sink = memoryErrorReporter();
        installErrorReporter(sink);
        reportError(boom(), { source: 'cli' });
        return sink.events[0] as ErrorReport;
      })(),
    );
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  test('one member is that member, none is the no-op', () => {
    const a = memoryErrorReporter();
    expect(chainErrorReporters(a)).toBe(a);
    expect(chainErrorReporters()).toBe(noopErrorReporter);
    expect(errorReportersOf(noopErrorReporter)).toEqual([]);
  });

  test('the installed reporter is readable, so a boot composes with what the app installed', () => {
    expect(installedErrorReporter()).toBe(noopErrorReporter);
    const app = memoryErrorReporter();
    installErrorReporter(app);
    expect(installedErrorReporter()).toBe(app);
  });
});
