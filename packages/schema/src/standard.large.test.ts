// A hostile body against the validator: 10k invalid items were 289 ms of sync CPU, a 7.2 MiB problem
// document and a 3.6 MiB cause. Validation stops at `MAX_ISSUES` and says the list is a prefix.

import { describe, expect, test } from 'bun:test';
import { checkOf, makeSchema } from './builder';
import { ValidationFailedError } from './errors';
import { MAX_ISSUES } from './issue-cap';
import { type StandardSchemaV1, validate, validateAsync } from './standard';
import { t } from './t';

const items = t.object({ items: t.array(t.object({ n: t.number, name: t.string })) });
const bad = (count: number) => ({
  items: Array.from({ length: count }, () => ({ n: 'x', name: 5 })),
});

const elapsed = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('a 10k-item invalid body', () => {
  // WORK, never wall time: a loaded CI runner moves milliseconds, not the number of checks made.
  // Before the cap every one of the 10k items was checked; now the loop stops at the 100th refusal.
  test('stops at MAX_ISSUES after checking MAX_ISSUES items, marked truncated', () => {
    let checked = 0;
    const item = checkOf(items.shape.items);
    // A builtin schema whose check counts its calls, then defers to the real item check.
    const counted = makeSchema<unknown, unknown>({ kind: 'unknown' }, (value, path) => {
      checked += 1;
      return item([value], path);
    });
    const result = validate(t.array(counted), bad(10_000).items);
    expect(MAX_ISSUES).toBe(100);
    expect(result.issues).toHaveLength(MAX_ISSUES);
    expect(result.issues === undefined ? undefined : result.issuesTruncated).toBe(true);
    // Each bad item yields two issues, so the cap is met by the 50th item and the rest are unread.
    expect(checked).toBeLessThanOrEqual(MAX_ISSUES);
  });

  test('parse throws a problem whose JSON is under 64 KiB', () => {
    try {
      items.parse(bad(10_000), 'input');
      expect.unreachable('a 10k-item invalid body parsed');
    } catch (error) {
      if (!(error instanceof ValidationFailedError)) throw error;
      expect(error.issues).toHaveLength(MAX_ISSUES);
      expect(error.issuesTruncated).toBe(true);
      expect(error.meta?.['issuesTruncated']).toBe(true);
      expect(JSON.stringify(error.toJSON()).length).toBeLessThan(64 * 1024);
    }
  });

  test('every builtin door is capped, not only validate()', () => {
    expect(items.safeParse(bad(500)).issues).toHaveLength(MAX_ISSUES);
    const standard = items['~standard'].validate(bad(500));
    expect('issues' in standard ? standard.issues : undefined).toHaveLength(MAX_ISSUES);
  });
});

describe('the cap itself', () => {
  const numbers = t.array(t.number);
  const strings = (count: number) => Array.from({ length: count }, () => 'x');

  test('exactly MAX_ISSUES issues is the whole list, not truncated', () => {
    const result = validate(numbers, strings(MAX_ISSUES));
    expect(result.issues).toHaveLength(MAX_ISSUES);
    expect(result.issues === undefined ? 'ok' : result.issuesTruncated).toBeUndefined();
  });

  test('one past it is truncated', () => {
    const result = validate(numbers, strings(MAX_ISSUES + 1));
    expect(result.issues).toHaveLength(MAX_ISSUES);
    expect(result.issues === undefined ? undefined : result.issuesTruncated).toBe(true);
  });

  test('maxIssues narrows it', () => {
    const result = validate(numbers, strings(50), { maxIssues: 5 });
    expect(result.issues).toHaveLength(5);
    expect(result.issues === undefined ? undefined : result.issuesTruncated).toBe(true);
  });

  test('a maxIssues no list can meet is refused with its code', () => {
    for (const maxIssues of [0, -1, 1.5, Number.NaN]) {
      expect(() => validate(numbers, [], { maxIssues })).toThrow(
        expect.objectContaining({ code: 'X_SCHEMA_ISSUE_CAP_INVALID' }),
      );
    }
  });

  test('nested arrays are held to the cap as a whole', () => {
    const grid = t.array(t.array(t.number));
    const rows = Array.from({ length: 50 }, () => strings(50));
    const result = validate(grid, rows);
    expect(result.issues).toHaveLength(MAX_ISSUES);
    expect(result.issues === undefined ? undefined : result.issuesTruncated).toBe(true);
  });

  test('a record and a json value stop too', () => {
    const record = Object.fromEntries(strings(500).map((value, index) => [`k${index}`, value]));
    expect(validate(t.record(t.number), record).issues).toHaveLength(MAX_ISSUES);
    const json = Array.from({ length: 500 }, () => Number.NaN);
    const result = validate(t.json(), json);
    expect(result.issues).toHaveLength(MAX_ISSUES);
    expect(result.issues === undefined ? undefined : result.issuesTruncated).toBe(true);
  });

  test('a union member that stopped early does not mark the union truncated', () => {
    const either = t.union(t.array(t.number), t.array(t.string));
    expect(validate(either, strings(500)).issues).toBeUndefined();
    const neither = validate(
      either,
      Array.from({ length: 500 }, () => true),
    );
    expect(neither.issues).toHaveLength(1);
    expect(neither.issues === undefined ? undefined : neither.issuesTruncated).toBeUndefined();
  });

  test("a foreign library's list is cut, and marked", async () => {
    const foreign: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'probe',
        validate: () => ({ issues: strings(1_000).map((message) => ({ message })) }),
      },
    };
    const sync = validate(foreign, null);
    expect(sync.issues).toHaveLength(MAX_ISSUES);
    const later = await validateAsync(foreign, null, { maxIssues: 3 });
    expect(later.issues).toHaveLength(3);
    expect(later.issues === undefined ? undefined : later.issuesTruncated).toBe(true);
  });
});

describe('a valid body stays linear', () => {
  // A generous wall-clock bound, 10x the ~3 µs/item measured on 2026-11-09: it catches a quadratic
  // regression (50k items squared is minutes) and survives a loaded runner. The cap's own pin is the
  // work count above, never this.
  test('50k valid items cost well under 30 µs each', () => {
    const good = {
      items: Array.from({ length: 50_000 }, (_, index) => ({ n: index, name: 'a' })),
    };
    validate(items, good);
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round += 1) {
      best = Math.min(
        best,
        elapsed(() => validate(items, good)),
      );
    }
    expect((best * 1000) / 50_000).toBeLessThan(30);
  });
});
