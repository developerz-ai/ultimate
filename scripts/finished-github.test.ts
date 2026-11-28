// `finished-github.ts`: the shape, flake-hunt and compat rows over an injected `gh` answering
// fixtures — green, red and unreadable for each, and a refusing `gh` is never green.

import { describe, expect, test } from 'bun:test';
import { compatRow, FLAKE_COMMAND, FLAKE_WEEKS, flakeRow, shapesRow } from './finished-github';
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

  test('the query asks for exactly the bar: the last FLAKE_WEEKS completed scheduled runs on main', () => {
    expect(FLAKE_COMMAND).toContain(`--limit ${String(FLAKE_WEEKS)} `);
    expect(FLAKE_COMMAND).toContain('--event schedule');
    expect(FLAKE_COMMAND).toContain('--status completed');
    expect(FLAKE_COMMAND).toContain('--branch main');
  });

  test('the newest run just inside eight days is green, just outside is red', async () => {
    const aged = (ms: number) =>
      weeks(FLAKE_WEEKS).map((one, at) => ({
        ...one,
        createdAt: new Date(NOW - ms - at * 7 * 86_400_000).toISOString(),
      }));
    const day = 86_400_000;
    expect((await flakeRow('/', fakeGh({ 'run list': aged(8 * day - 60_000) }), NOW)).verdict).toBe(
      'green',
    );
    expect((await flakeRow('/', fakeGh({ 'run list': aged(8 * day + 60_000) }), NOW)).verdict).toBe(
      'red',
    );
  });

  // The cutover: one weekly run beside three nightly ones from before 2026-11-28 is not four weeks.
  test('nightly runs from the old schedule never count as weekly hunts', async () => {
    const cutover = [
      week('success', 0),
      ...[1, 2, 3].map((days) => ({
        conclusion: 'success',
        createdAt: new Date(NOW - 3_600_000 - (2 + days) * 86_400_000).toISOString(),
        url: `n${String(days)}`,
      })),
    ];
    const row = await flakeRow('/', fakeGh({ 'run list': cutover }), NOW);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.cause).toContain('not 4 weekly runs');
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
