// The projection is what makes an overdue flag listable rather than only reportable: `x flags`,
// an MCP tool and the manifest all read this one shape, so none of them recomputes "expired".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { flagsReport } from './projection';
import { defineFlag, resetFlags } from './registry';
import { configureFlags, resetFlagReporting } from './runtime';

beforeEach(() => {
  resetFlags();
  resetFlagReporting();
});

afterEach(() => {
  resetFlags();
  resetFlagReporting();
});

const declareThree = (): void => {
  defineFlag({
    kind: 'permanent',
    key: 'billing.dunning-emails',
    description: 'ops kill switch for dunning email delivery',
    targeting: { default: true },
  });
  defineFlag({
    kind: 'temporary',
    key: 'checkout.new-tax-engine',
    description: 'routes checkout through the rewritten tax engine',
    owner: 'payments',
    expiresAt: '2026-01-01',
    targeting: { default: false, rollout: 10 },
  });
  defineFlag({
    kind: 'temporary',
    key: 'search.rerank',
    description: 'reranks results with the new model',
    owner: 'search',
    expiresAt: '2027-06-01',
    targeting: { default: false },
  });
};

describe('unit · flagsReport', () => {
  test('enumerates every flag with its kind, expiry and owner, sorted by key', () => {
    configureFlags({ clock: frozenClock('2026-03-05T00:00:00.000Z') });
    declareThree();

    const report = flagsReport();

    expect(report.flags.map((flag) => flag.key)).toEqual([
      'billing.dunning-emails',
      'checkout.new-tax-engine',
      'search.rerank',
    ]);
    expect(report.flags.map((flag) => flag.kind)).toEqual(['permanent', 'temporary', 'temporary']);
    expect(report.flags.map((flag) => flag.owner)).toEqual([null, 'payments', 'search']);
    expect(report.flags.map((flag) => flag.expiresAt)).toEqual([null, '2026-01-01', '2027-06-01']);
  });

  test('names exactly the flags that are past their expiry as of now', () => {
    configureFlags({ clock: frozenClock('2026-03-05T00:00:00.000Z') });
    declareThree();

    expect(flagsReport().expired).toEqual(['checkout.new-tax-engine']);
  });

  test('a permanent flag is never expired, however far the clock is moved', () => {
    const clock = frozenClock('2026-03-05T00:00:00.000Z');
    configureFlags({ clock });
    declareThree();
    clock.set('2099-01-01T00:00:00.000Z');

    const report = flagsReport();

    expect(report.flags[0]?.expired).toBe(false);
    expect(report.expired).toEqual(['checkout.new-tax-engine', 'search.rerank']);
  });

  test('is JSON-safe, because --json is the surface it exists for', () => {
    configureFlags({ clock: frozenClock('2026-03-05T00:00:00.000Z') });
    declareThree();

    expect(JSON.parse(JSON.stringify(flagsReport())).expired).toEqual(['checkout.new-tax-engine']);
  });
});
