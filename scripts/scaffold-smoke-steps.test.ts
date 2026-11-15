// A green step table can be green on skips. These pin that the scaffold smoke reads each step's
// check count off the gate's own `--json` document, and excuses only what `x.verify.json` writes
// a why for.

import { describe, expect, test } from 'bun:test';
import {
  excusedSteps,
  ranACheck,
  ranSteps,
  ranSummary,
  unrunFindings,
} from './scaffold-smoke-steps';

const DIR = '/tmp/demoapp';
const declared = ['typecheck', 'unit', 'live', 'roadmap'];

const doc = (steps: readonly Record<string, unknown>[]): string =>
  `progress line\n${JSON.stringify({ ok: true, steps })}\n`;

describe('unit · scaffold smoke · every step ran a check', () => {
  test('a suite step is read with its tests.ran; a check step has none', () => {
    const steps = ranSteps(
      doc([
        { name: 'typecheck', ok: true },
        { name: 'unit', ok: true, tests: { ran: 12, skipped: 0 } },
        { name: 'roadmap', ok: true, skipped: true },
      ]),
    );
    expect(steps).toEqual([
      { name: 'typecheck', skipped: false },
      { name: 'unit', skipped: false, ran: 12 },
      { name: 'roadmap', skipped: true },
    ]);
  });

  test('a suite of zero tests ran no check, and neither did a skipped step', () => {
    expect(ranACheck({ name: 'live', skipped: false, ran: 0 })).toBe(false);
    expect(ranACheck({ name: 'live', skipped: true })).toBe(false);
    expect(ranACheck({ name: 'live', skipped: false, ran: 1 })).toBe(true);
    expect(ranACheck({ name: 'lint', skipped: false })).toBe(true);
  });

  test('only a skip entry with a written why excuses a step', () => {
    expect(excusedSteps(JSON.stringify({ skip: { roadmap: 'framework only', job: ' ' } }))).toEqual(
      ['roadmap'],
    );
    expect(excusedSteps(undefined)).toEqual([]);
    expect(excusedSteps('not json')).toEqual([]);
  });

  test('an unexcused step that ran nothing is red; a missing one too; an excused one is not', () => {
    const steps = [
      { name: 'typecheck', skipped: false },
      { name: 'unit', skipped: false, ran: 4 },
      { name: 'roadmap', skipped: true },
    ];
    expect(unrunFindings({ dir: DIR, steps, declared, excused: ['roadmap'] })).toEqual([
      expect.objectContaining({ code: 'X_SCAFFOLD_GATE_RED' }),
    ]);
    const [finding] = unrunFindings({
      dir: DIR,
      steps: [...steps, { name: 'live', skipped: false, ran: 0 }],
      declared,
      excused: [],
    });
    expect(finding?.cause).toStartWith('live, roadmap ran no check');
    expect(
      unrunFindings({
        dir: DIR,
        steps: [...steps, { name: 'live', skipped: false, ran: 3 }],
        declared,
        excused: ['roadmap'],
      }),
    ).toEqual([]);
  });

  test('the summary counts what ran and names what was excused', () => {
    const steps = [
      { name: 'typecheck', skipped: false },
      { name: 'unit', skipped: false, ran: 4 },
      { name: 'live', skipped: false, ran: 0 },
      { name: 'roadmap', skipped: true },
    ];
    expect(ranSummary({ dir: DIR, steps, declared, excused: ['roadmap'] })).toBe(
      '2 of 4 steps ran a check, excused: roadmap',
    );
  });
});
