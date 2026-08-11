// The lifecycle rule is the reason this package exists, so these are the tests that must be able
// to fail: an overdue temporary flag reports, a rate-limited report is still ONE report, a
// permanent flag never reports, and a key nobody declared is an error rather than a quiet `false`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MemoryErrorReporter, UltimateError } from '@ultimat3/core';
import {
  anonymousActor,
  configureErrorReporting,
  frozenClock,
  memoryErrorReporter,
  resetErrorReporting,
  userActor,
} from '@ultimat3/core';
import { isEnabled } from './evaluate';
import { defineFlag, resetFlags } from './registry';
import { configureFlags, resetFlagReporting } from './runtime';

const EXPIRY = '2026-01-01';
const LONG_AFTER = '2026-03-05T00:00:00.000Z';
const REPORT_EVERY_MS = 60_000;

const actor = userActor({ id: 'user-1' });

let sink: MemoryErrorReporter;

/** The thrown value, so a test can assert its code instead of only that something threw. */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

beforeEach(() => {
  sink = memoryErrorReporter();
  resetFlags();
  resetFlagReporting();
  resetErrorReporting();
  configureErrorReporting({ reporter: sink });
});

afterEach(() => {
  resetFlags();
  resetFlagReporting();
  resetErrorReporting();
});

describe('unit · an overdue temporary flag', () => {
  const declareOverdue = (): void => {
    defineFlag({
      kind: 'temporary',
      key: 'checkout.new-tax-engine',
      description: 'routes checkout through the rewritten tax engine',
      owner: 'payments',
      expiresAt: EXPIRY,
      targeting: { default: false, actors: ['user-1'] },
    });
  };

  test('reports itself to the error monitor when it is evaluated past its expiry', () => {
    configureFlags({ clock: frozenClock(LONG_AFTER) });
    declareOverdue();

    expect(isEnabled('checkout.new-tax-engine', actor)).toBe(true);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.code).toBe('X_FLAG_EXPIRED');
    expect(sink.events[0]?.cause).toContain('checkout.new-tax-engine');
    expect(sink.events[0]?.cause).toContain('payments');
    expect(sink.events[0]?.fix).toContain('defineFlag()');
  });

  test('is rate-limited: a hundred evaluations inside the window are still one report', () => {
    configureFlags({ clock: frozenClock(LONG_AFTER), reportEveryMs: REPORT_EVERY_MS });
    declareOverdue();

    for (let call = 0; call < 100; call += 1) isEnabled('checkout.new-tax-engine', actor);

    expect(sink.events).toHaveLength(1);
  });

  test('reports again once the window has passed, so the debt does not go quiet', () => {
    const clock = frozenClock(LONG_AFTER);
    configureFlags({ clock, reportEveryMs: REPORT_EVERY_MS });
    declareOverdue();

    isEnabled('checkout.new-tax-engine', actor);
    clock.advance(REPORT_EVERY_MS - 1);
    isEnabled('checkout.new-tax-engine', actor);
    expect(sink.events).toHaveLength(1);

    clock.advance(2);
    isEnabled('checkout.new-tax-engine', actor);
    expect(sink.events).toHaveLength(2);
  });

  test('still answers its targeting — an expiry is a debt, not an outage', () => {
    configureFlags({ clock: frozenClock(LONG_AFTER) });
    declareOverdue();

    expect(isEnabled('checkout.new-tax-engine', actor)).toBe(true);
    expect(isEnabled('checkout.new-tax-engine', userActor({ id: 'user-2' }))).toBe(false);
  });

  test('does not report before its expiry', () => {
    configureFlags({ clock: frozenClock('2025-12-31T00:00:00.000Z') });
    declareOverdue();

    isEnabled('checkout.new-tax-engine', actor);

    expect(sink.events).toHaveLength(0);
  });

  test('a monitor that throws does not take the evaluation down with it', () => {
    configureFlags({ clock: frozenClock(LONG_AFTER) });
    configureErrorReporting({
      reporter: {
        report(): void {
          throw new Error('monitor is down');
        },
      },
    });
    declareOverdue();

    expect(isEnabled('checkout.new-tax-engine', actor)).toBe(true);
  });
});

describe('unit · a permanent flag', () => {
  test('never reports, however far in the future it is evaluated', () => {
    configureFlags({ clock: frozenClock('2099-01-01T00:00:00.000Z') });
    defineFlag({
      kind: 'permanent',
      key: 'billing.dunning-emails',
      description: 'ops kill switch for dunning email delivery',
      targeting: { default: true },
    });

    for (let call = 0; call < 10; call += 1) isEnabled('billing.dunning-emails', anonymousActor());

    expect(sink.events).toHaveLength(0);
  });
});

describe('unit · an undeclared key', () => {
  test('throws X_FLAG_UNKNOWN rather than answering a silent false', () => {
    defineFlag({
      kind: 'permanent',
      key: 'billing.dunning-emails',
      description: 'ops kill switch for dunning email delivery',
      targeting: { default: true },
    });

    const thrown = caught(() => isEnabled('billing.dunning-email', actor));

    expect(thrown).toBeUltimateError('X_FLAG_UNKNOWN');
    expect((thrown as UltimateError).fix).toContain('defineFlag(');
  });
});
