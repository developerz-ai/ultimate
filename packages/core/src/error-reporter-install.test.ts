// The `errorReporter` port: installed through `@ultimat3/core/adapter` with a release, never through
// `configureErrorReporting` — which keeps the non-port settings (clock, release, environment, enabled).

import { afterEach, describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import {
  configureErrorReporting,
  installErrorReporter,
  installedErrorReporter,
  memoryErrorReporter,
  noopErrorReporter,
  reportError,
  resetErrorReporting,
} from './error-reporter';
import { isUltimateError } from './errors';
import * as barrel from './index';

afterEach(() => resetErrorReporting());

describe('unit · installErrorReporter', () => {
  test('the installed reporter receives every report, and its release puts back the one before', () => {
    const below = memoryErrorReporter();
    const above = memoryErrorReporter();
    const releaseBelow = installErrorReporter(below);
    const releaseAbove = installErrorReporter(above);
    reportError(new TypeError('boom'), { source: 'job' });
    expect([below.events.length, above.events.length]).toEqual([0, 1]);
    releaseAbove();
    expect(installedErrorReporter()).toBe(below);
    releaseBelow();
    expect(installedErrorReporter()).toBe(noopErrorReporter);
  });

  test('releases stop in any order, and twice is harmless', () => {
    const first = memoryErrorReporter();
    const second = memoryErrorReporter();
    const releaseFirst = installErrorReporter(first);
    installErrorReporter(second);
    releaseFirst();
    releaseFirst();
    expect(installedErrorReporter()).toBe(second);
  });

  test('configureErrorReporting never replaces an installed reporter (its `reporter` key is `never`: type-pins.ts)', () => {
    const mine = memoryErrorReporter();
    installErrorReporter(mine);
    configureErrorReporting({ release: 'build-1' });
    expect(installedErrorReporter()).toBe(mine);
  });

  // The type says `never`; an untyped caller (a `.js` module, a test, a cast) must not be ignored
  // silently — its reporter would never receive a report.
  test('a reporter handed to configureErrorReporting is refused, naming the runtime.ts field', () => {
    const stale = { reporter: memoryErrorReporter() } as unknown as Parameters<
      typeof configureErrorReporting
    >[0];
    let refusal: unknown;
    try {
      configureErrorReporting(stale);
    } catch (error) {
      refusal = error;
    }
    expect(isUltimateError(refusal) ? refusal.code : 'not refused').toBe('X_CONFIG_INVALID');
    expect(isUltimateError(refusal) ? refusal.fix : '').toContain('errorReporter:');
    expect(installedErrorReporter()).toBe(noopErrorReporter);
  });

  test('resetErrorReporting drops every install, back to the no-op', () => {
    installErrorReporter(memoryErrorReporter());
    resetErrorReporting();
    expect(installedErrorReporter()).toBe(noopErrorReporter);
  });

  test('the installer is on ./adapter, never on the barrel; the reader stays on the barrel', () => {
    expect(adapter.installErrorReporter).toBe(installErrorReporter);
    expect(Object.keys(barrel)).not.toContain('installErrorReporter');
    expect(barrel.installedErrorReporter).toBe(installedErrorReporter);
  });
});
