// The budget gate's own contract: a blown budget fails, and — the case this file exists for — a
// declared budget nothing measured fails too. A route that clears `x verify` without ever being
// weighed is the false green axiom 5 forbids.

import { describe, expect, test } from 'bun:test';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest } from '@ultimat3/manifest';
import type { BuildStats } from './budgets';
import { BUILD_STATS_FILE, checkBudgets } from './budgets';

const manifestOf = (...routes: readonly RouteFact[]) =>
  buildManifest({ app: { name: 'fixture', version: '1.0.0' }, routes });

const route = (url: string, budget?: RouteFact['budget']): RouteFact => ({
  url,
  render: 'static',
  ...(budget === undefined ? {} : { budget }),
});

const stats = (...routes: BuildStats['routes']): BuildStats => ({ routes });

describe('unit · budgets', () => {
  test('a declared JS budget with no measurement is a finding, not a pass', () => {
    const findings = checkBudgets(manifestOf(route('/pricing', { js: '20kb' })), stats());
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
    expect(findings[0]?.cause).toContain('/pricing');
    expect(findings[0]?.cause).toContain('JS');
    expect(findings[0]?.cause).toContain(BUILD_STATS_FILE);
    expect(findings[0]?.fix).toBe('x build && x verify');
    expect(findings[0]?.at).toBe('/pricing');
  });

  test('a declared LCP budget with no measurement is a finding too', () => {
    const findings = checkBudgets(manifestOf(route('/slow', { lcp: 1200 })), stats());
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_UNMEASURED']);
    expect(findings[0]?.cause).toContain('LCP');
    expect(findings[0]?.cause).not.toContain('JS');
  });

  test('both budgets unmeasured is one finding that names both', () => {
    const findings = checkBudgets(manifestOf(route('/both', { js: '5kb', lcp: 900 })), stats());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('JS and LCP');
  });

  test('a route that declares no budget and was never measured is not a finding', () => {
    expect(checkBudgets(manifestOf(route('/about')), stats())).toEqual([]);
  });

  test('a measured route over its JS budget names the import chain that caused it', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { js: '10kb' })),
      stats({ path: '/dash', jsBytes: 40_000, heaviestChain: ['/dash', 'chart.ts'] }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
    expect(findings[0]?.cause).toContain('/dash -> chart.ts');
  });

  test('a measured route inside both budgets passes', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { js: '10kb', lcp: 1500 })),
      stats({ path: '/dash', jsBytes: 1_000, lcpMs: 900 }),
    );
    expect(findings).toEqual([]);
  });

  test('a measured route over its LCP budget fails on LCP alone', () => {
    const findings = checkBudgets(
      manifestOf(route('/dash', { lcp: 1000 })),
      stats({ path: '/dash', jsBytes: 0, lcpMs: 2400 }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
    expect(findings[0]?.cause).toContain('2400ms');
  });
});
