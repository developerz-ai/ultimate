// `exercise.unprovenMax`: an all-unproven pass is never a silent green. Red only above a floor the
// app declared; with none, a warning naming the figure to write; under it, a warning to lower it.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord } from '@ultimat3/testing';
import { fixProblem } from './error-contract';
import { judgeUnproven, readExerciseFloor, unprovenTally } from './exercise-floor';
import { floorProblemFindings, parseVerifyFloor } from './verify-floor';

const reached = (name: string, over: Partial<ExerciseRecord> = {}): ExerciseRecord =>
  ({
    kind: 'query',
    name,
    outcome: 'reached',
    statements: 1,
    effects: [],
    ms: 1,
    ...over,
  }) as ExerciseRecord;

const unproven = (name: string): ExerciseRecord =>
  reached(name, { scale: { verdict: 'unproven', reason: 'the sized seed of posts failed' } });

const ALL_UNPROVEN = [unproven('feed'), unproven('search'), unproven('inbox')];

describe('unit · unprovenTally', () => {
  test('counts reached records any proof could not ask, over the reached only', () => {
    const tally = unprovenTally([
      unproven('feed'),
      reached('list', { tenant: { verdict: 'unproven', reason: 'A was not reached' } }),
      reached('charge', { kind: 'job', crash: { verdict: 'unproven', reason: 'timed out' } }),
      reached('ok', { tenant: { verdict: 'proven' } }),
      { ...unproven('never'), outcome: 'unreached' } as ExerciseRecord,
    ]);
    expect(tally.reached).toBe(4);
    expect(tally.unproven.map((one) => one.name)).toEqual([
      'query feed',
      'query list',
      'job charge',
    ]);
    expect(tally.figure).toBe(0.75);
  });

  test('the figure rounds UP, so a written figure holds the run it came from', () => {
    const tally = unprovenTally([unproven('a'), reached('b'), reached('c')]);
    expect(tally.figure).toBe(0.3334);
    expect(tally.figure).toBeGreaterThanOrEqual(1 / 3);
  });

  // 7 / 100 * 10 000 is 700.0000000000001 in floats: ceil'd, the figure read 0.0701.
  test('an exact ratio is its own figure, never one ten-thousandth over', () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      i < 7 ? unproven(`u${i}`) : reached(`r${i}`),
    );
    expect(unprovenTally(records).figure).toBe(0.07);
  });

  test('nothing reached is figure 0, never NaN', () => {
    expect(unprovenTally([]).figure).toBe(0);
  });
});

const pass = (count: number, of: number): ExerciseRecord[] =>
  Array.from({ length: of }, (_, i) => (i < count ? unproven(`u${i}`) : reached(`r${i}`)));

describe('unit · judgeUnproven', () => {
  // 0.29 * 100 is 28.999999999999996 and 0.07 * 100 is 7.000000000000001: compared in integers.
  test('a pass exactly at its declared floor is green, whichever way the floats round', () => {
    for (const [count, max] of [
      [7, 0.07],
      [29, 0.29],
      [57, 0.57],
    ] as const) {
      expect(judgeUnproven(pass(count, 100), { unprovenMax: max })).toEqual({
        findings: [],
        warnings: [],
      });
    }
    expect(judgeUnproven(pass(8, 100), { unprovenMax: 0.07 }).findings).toHaveLength(1);
    expect(judgeUnproven(pass(1, 3), { unprovenMax: 0.33333 }).findings).toHaveLength(1);
    // Judged on the ratio itself, never the rounded-up figure: 1 / 3 is under 0.33334.
    expect(judgeUnproven(pass(1, 3), { unprovenMax: 0.33334 }).findings).toEqual([]);
  });

  test('all-unproven against a declared 0 is red under X_EXERCISE_UNPROVEN_ABOVE_FLOOR', () => {
    const { findings, warnings } = judgeUnproven(ALL_UNPROVEN, { unprovenMax: 0 });
    expect(warnings).toEqual([]);
    expect(findings.map((one) => one.code)).toEqual(['X_EXERCISE_UNPROVEN_ABOVE_FLOOR']);
    expect(findings[0]?.cause).toContain('3 of 3 reached');
    expect(findings[0]?.cause).toContain('the sized seed of posts failed');
    expect(findings[0]?.at).toBe('x.verify.json');
    expect(fixProblem(findings[0]?.fix ?? '')).toBeUndefined();
    expect(findings[0]?.fix.startsWith('x exercise --json')).toBe(true);
  });

  test('an app that never opted in is warned with the figure to write, never red', () => {
    const { findings, warnings } = judgeUnproven(ALL_UNPROVEN, undefined);
    expect(findings).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"exercise": { "unprovenMax": 1 }');
  });

  test('at the floor is silent; under it a warning names the lower figure', () => {
    const records = [unproven('a'), reached('b'), reached('c'), reached('d')];
    expect(judgeUnproven(records, { unprovenMax: 0.25 })).toEqual({ findings: [], warnings: [] });
    const under = judgeUnproven(records, { unprovenMax: 0.5 });
    expect(under.findings).toEqual([]);
    expect(under.warnings[0]).toContain('"unprovenMax": 0.25');
  });

  test('everything proven with no floor says nothing', () => {
    expect(judgeUnproven([reached('a')], undefined)).toEqual({ findings: [], warnings: [] });
  });
});

describe('unit · the exercise key in x.verify.json', () => {
  test('a ratio and a statement ceiling are read', () => {
    expect(readExerciseFloor({ exercise: { unprovenMax: 0.1, statementsMax: 100 } })).toEqual({
      floor: { unprovenMax: 0.1, statementsMax: 100 },
      problems: [],
    });
    expect(
      parseVerifyFloor('{"steps":["unit"],"exercise":{"unprovenMax":0}}', ['unit']).exercise,
    ).toEqual({ unprovenMax: 0 });
  });

  test('absent is no floor and no problem', () => {
    expect(readExerciseFloor({})).toEqual({ problems: [] });
    expect(parseVerifyFloor('{"steps":["unit"]}', ['unit']).exercise).toBeUndefined();
  });

  test('a ratio above 1, a fraction of statements, a typo and a non-object are problems', () => {
    const { floor, problems } = readExerciseFloor({
      exercise: { unprovenMax: 5, statementsMax: 2.5, unprovenMx: 0 },
    });
    expect(floor).toBeUndefined();
    expect(problems).toHaveLength(3);
    expect(readExerciseFloor({ exercise: [] }).problems).toHaveLength(1);
  });

  test('a bad key reaches the manifest step with a fix that repairs it', () => {
    const floor = parseVerifyFloor('{"steps":["unit"],"exercise":{"unprovenMax":"5%"}}', ['unit']);
    const [finding] = floorProblemFindings(floor);
    expect(finding?.code).toBe('X_CONFIG_INVALID');
    expect(finding?.fix).toContain('"unprovenMax": 0');
    expect(fixProblem(finding?.fix ?? '')).toBeUndefined();
  });
});
