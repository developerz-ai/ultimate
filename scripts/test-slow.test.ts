// The slow-test rule, on inputs built by hand: a file over the budget with no stated reason, the
// reason that clears it, the reason a fast file no longer needs, and the weights that read nothing.
// Never against the committed weights: what this repo measures is the gate's verdict, not a unit's.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for a temp directory or a recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fixShape } from './lib/fix-shape';
import {
  checkSlowTests,
  parseWeights,
  SLOW_TEST_BUDGET_MS,
  slowReasonOf,
  slowTestFindings,
  TEST_WEIGHTS_FILE,
} from './test-slow';

const SLOW = 'packages/x/src/heavy.test.ts';
const FAST = 'packages/x/src/light.test.ts';
const OVER = SLOW_TEST_BUDGET_MS + 1;

const weights = (files: Record<string, number>) => ({
  measuredAt: '2026-11-16T00:00:00Z',
  source: 'local',
  files,
});

const read = (files: Record<string, number>) => {
  const parsed = parseWeights(weights(files));
  if (parsed.kind !== 'read') return expect.unreachable('a well-formed weights file parses');
  return parsed;
};

const HEADER = '// Heavy: boots a scratch Postgres.\n';
const REASON =
  '// slow: one scratch Postgres per shape, and the assertion is the migration replay\n';
const BODY = "import { test } from 'bun:test';\ntest('x', () => {});\n";

describe('slowReasonOf', () => {
  test('a stated reason in the header comment is read, with its line', () => {
    expect(slowReasonOf(`#!/usr/bin/env bun\n${HEADER}${REASON}${BODY}`)).toEqual({
      line: 3,
      reason: 'one scratch Postgres per shape, and the assertion is the migration replay',
    });
  });

  test('a reason below the first statement, a bare marker or a short one is no reason', () => {
    expect(slowReasonOf(`${HEADER}${BODY}${REASON}`)).toBeUndefined();
    expect(slowReasonOf(`${HEADER}// slow:\n${BODY}`)).toBeUndefined();
    expect(slowReasonOf(`${HEADER}// slow: db\n${BODY}`)).toBeUndefined();
    expect(slowReasonOf(`${HEADER}// slowly: boots a scratch Postgres per shape\n${BODY}`)).toBe(
      undefined,
    );
  });
});

describe('parseWeights', () => {
  test('anything but { files: { <path>: <ms> } } with one entry reads nothing', () => {
    expect(parseWeights(undefined).kind).toBe('unread');
    expect(parseWeights([]).kind).toBe('unread');
    expect(parseWeights({ files: [] }).kind).toBe('unread');
    expect(parseWeights(weights({})).kind).toBe('unread');
    expect(parseWeights(weights({ [SLOW]: -1 })).kind).toBe('unread');
    expect(parseWeights(weights({ [SLOW]: Number.NaN })).kind).toBe('unread');
    expect(parseWeights(weights({ [SLOW]: 5 })).kind).toBe('read');
  });
});

describe('checkSlowTests', () => {
  test('a file over the budget with no stated reason is X_TEST_SLOW_UNSTATED, at its header', () => {
    const findings = checkSlowTests(
      read({ [SLOW]: OVER, [FAST]: 10 }),
      new Map([
        [SLOW, `${HEADER}${BODY}`],
        [FAST, BODY],
      ]),
    ).findings;
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_TEST_SLOW_UNSTATED', `${SLOW}:2`],
    ]);
    const fix = findings[0]?.fix ?? '';
    expect(fixShape(fix)).toBe('edit');
    expect(fix.startsWith(`edit ${SLOW}:2 — `)).toBe(true);
  });

  test('at the budget passes; over it with a stated reason passes, and the reason is reported', () => {
    const report = checkSlowTests(
      read({ [SLOW]: OVER, [FAST]: SLOW_TEST_BUDGET_MS }),
      new Map([
        [SLOW, `${HEADER}${REASON}${BODY}`],
        [FAST, BODY],
      ]),
    );
    expect(report.findings).toEqual([]);
    expect(report.over).toEqual([
      {
        path: SLOW,
        ms: OVER,
        reason: 'one scratch Postgres per shape, and the assertion is the migration replay',
      },
    ]);
  });

  test('a reason on a file under half the budget is X_TEST_SLOW_REASON_STALE; between, it stays', () => {
    const half = SLOW_TEST_BUDGET_MS / 2;
    const marked = `${HEADER}${REASON}${BODY}`;
    const findings = checkSlowTests(
      read({ [SLOW]: half - 1, [FAST]: half }),
      new Map([
        [SLOW, marked],
        [FAST, marked],
      ]),
    ).findings;
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_TEST_SLOW_REASON_STALE', `${SLOW}:2`],
    ]);
    expect(fixShape(findings[0]?.fix ?? '')).toBe('edit');
  });

  test('a reason on a file no weight measured is left alone: no number says it is fast', () => {
    expect(
      checkSlowTests(read({ [FAST]: 1 }), new Map([[SLOW, `${REASON}${BODY}`]])).findings,
    ).toEqual([]);
  });

  test('a weight for a file the tree no longer holds is data for the writer, never a finding', () => {
    const report = checkSlowTests(read({ [SLOW]: OVER }), new Map());
    expect(report.findings).toEqual([]);
    expect(report.staleWeights).toEqual([SLOW]);
  });

  test('weights that read nothing are X_TEST_SLOW_UNSCANNED, never a clean tree', () => {
    const findings = checkSlowTests(parseWeights(weights({})), new Map([[SLOW, BODY]])).findings;
    expect(findings.map((finding) => finding.code)).toEqual(['X_TEST_SLOW_UNSCANNED']);
    expect(fixShape(findings[0]?.fix ?? '')).toBe('command');
    expect(findings[0]?.fix).toContain('bun run scripts/test-weights.ts ');
  });
});

describe('slowTestFindings over a root', () => {
  let root = '';
  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  test('a root with test files and no weights file is X_TEST_SLOW_UNSCANNED', async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-test-slow-'));
    await Bun.write(join(root, SLOW), BODY);
    expect((await slowTestFindings(root)).map((finding) => finding.code)).toEqual([
      'X_TEST_SLOW_UNSCANNED',
    ]);
  });

  test('the committed weights are read, and a slow file outside the corpus globs is read too', async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-test-slow-'));
    const hook = '.claude/hooks/guard.test.ts';
    await Bun.write(join(root, SLOW), `${HEADER}${REASON}${BODY}`);
    await Bun.write(join(root, hook), BODY);
    await Bun.write(
      join(root, TEST_WEIGHTS_FILE),
      JSON.stringify(weights({ [SLOW]: OVER, [hook]: OVER })),
    );
    expect((await slowTestFindings(root)).map((finding) => [finding.code, finding.at])).toEqual([
      ['X_TEST_SLOW_UNSTATED', `${hook}:1`],
    ]);
  });
});
