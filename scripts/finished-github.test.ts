// `finished-github.ts`: the shape, flake-hunt and compat rows over an injected `gh` answering
// fixtures — green, red and unreadable for each, and a refusing `gh` is never green.

import { describe, expect, test } from 'bun:test';
import { compatRow, FLAKE_WEEKS, flakeRow, shapesRow } from './finished-github';
import type { Runner } from './finished-rule';
import type { RunResult } from './lib/run';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const answer = (doc: unknown, ok = true): RunResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
  output: ok ? JSON.stringify(doc) : 'HTTP 401: Bad credentials',
  durationMs: 0,
  timedOut: false,
});
/** A `gh` that answers by the argv's first words; anything unscripted refuses. */
const fakeGh =
  (routes: Readonly<Record<string, unknown>>): Runner =>
  async (args) => {
    const key = Object.keys(routes).find((prefix) => args.join(' ').startsWith(prefix));
    return key === undefined ? answer(undefined, false) : answer(routes[key]);
  };
const refusing: Runner = async () => answer(undefined, false);
const jobs = (conclusions: Record<string, string>) => ({
  jobs: Object.entries(conclusions).map(([shape, conclusion]) => ({
    name: `scaffold-smoke (${shape}app)`,
    conclusion,
  })),
});

describe('finished · every-shape-gates', () => {
  const runs = [
    { databaseId: 2, url: 'u2' },
    { databaseId: 1, url: 'u1' },
  ];

  test('every shape green on the newest push is green', async () => {
    const gh = fakeGh({
      'run list': runs,
      'run view 2': jobs({ api: 'success', saas: 'success' }),
    });
    expect((await shapesRow(['api', 'saas'], '/', gh)).verdict).toBe('green');
  });

  test('a skipped job is read off the next older run', async () => {
    const gh = fakeGh({
      'run list': runs,
      'run view 2': jobs({ api: 'skipped' }),
      'run view 1': jobs({ api: 'failure' }),
    });
    const row = await shapesRow(['api'], '/', gh);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.cause).toContain('ended failure on main: u1');
  });

  test('a cancelled job is no evidence either', async () => {
    const gh = fakeGh({
      'run list': runs,
      'run view 2': jobs({ api: 'cancelled' }),
      'run view 1': jobs({ api: 'success' }),
    });
    expect((await shapesRow(['api'], '/', gh)).verdict).toBe('green');
  });

  test('a shape no run carries is red', async () => {
    const gh = fakeGh({ 'run list': runs, 'run view': jobs({ api: 'success' }) });
    const row = await shapesRow(['api', 'offline'], '/', gh);
    expect(row.verdict).toBe('red');
    expect(row.findings.map((one) => one.code)).toEqual(['X_FINISHED_SHAPE_UNGATED']);
  });

  test('a gh that cannot read is unverdicted', async () => {
    expect((await shapesRow(['api'], '/', refusing)).verdict).toBe('unverdicted');
  });
});

describe('finished · tests-deterministic', () => {
  const week = (conclusion: string, weeksAgo: number) => ({
    conclusion,
    createdAt: new Date(NOW - weeksAgo * 7 * 86_400_000 - 3_600_000).toISOString(),
    url: `w${weeksAgo}`,
  });
  const weeks = (count: number, red = -1) =>
    Array.from({ length: count }, (_, at) => week(at === red ? 'failure' : 'success', at));

  test(`${FLAKE_WEEKS} green weekly runs, the newest fresh, are green`, async () => {
    expect((await flakeRow('/', fakeGh({ 'run list': weeks(FLAKE_WEEKS) }), NOW)).verdict).toBe(
      'green',
    );
  });

  test('one red week, too few weeks, or a stopped schedule is red', async () => {
    for (const runs of [
      weeks(FLAKE_WEEKS, 2),
      weeks(FLAKE_WEEKS - 1),
      weeks(FLAKE_WEEKS).map((one) => ({ ...one, createdAt: '2026-11-01T00:00:00Z' })),
    ]) {
      const row = await flakeRow('/', fakeGh({ 'run list': runs }), NOW);
      expect(row.verdict).toBe('red');
      expect(row.findings[0]?.code).toBe('X_FINISHED_FLAKY');
    }
  });

  test('a gh that cannot read is unverdicted', async () => {
    expect((await flakeRow('/', refusing, NOW)).verdict).toBe('unverdicted');
  });
});

describe('finished · range-tested', () => {
  const run = (conclusion: string) => [
    { databaseId: 9, status: 'completed', conclusion, createdAt: '2026-11-15T00:00:00Z', url: 'c' },
  ];

  test('the newest compat run green is green; failed is red', async () => {
    expect((await compatRow('/', fakeGh({ 'run list': run('success') }), NOW)).verdict).toBe(
      'green',
    );
    const row = await compatRow('/', fakeGh({ 'run list': run('failure') }), NOW);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.code).toBe('X_FINISHED_COMPAT_RED');
  });

  test('a gh that cannot read is unverdicted', async () => {
    expect((await compatRow('/', refusing, NOW)).verdict).toBe('unverdicted');
  });
});
