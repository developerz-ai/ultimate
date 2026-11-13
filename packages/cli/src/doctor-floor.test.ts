import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the fixture app needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { STEP_UNFLOORED, unflooredStepFindings, unflooredStepsProbe } from './doctor-floor';
import type { VerifyStep, VerifyStepName } from './verify-step';
import { passed } from './verify-step';

/** A step whose `applies` answers `answer`, the shape every suite step has. */
const step = (name: VerifyStepName, answer: boolean): VerifyStep => ({
  name,
  summary: name,
  applies: async () => answer,
  run: async () => passed,
});

const withFloor = async (floor: unknown, body: (root: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'x-doctor-floor-'));
  try {
    if (floor !== undefined) await Bun.write(join(root, 'x.verify.json'), JSON.stringify(floor));
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('unit · x doctor unfloored steps', () => {
  test('a step that applies and is not floored is reported; a floored one is not', async () => {
    await withFloor({ steps: ['live'] }, async (root) => {
      const steps = [step('live', true), step('job', true), step('contract', false)];
      expect(await unflooredStepsProbe(root, steps)).toEqual(['job']);
    });
  });

  test('a step with no applies always runs, so there is nothing to floor', async () => {
    await withFloor({ steps: [] }, async (root) => {
      const always: VerifyStep = { name: 'lint', summary: 'lint', run: async () => passed };
      expect(await unflooredStepsProbe(root, [always])).toEqual([]);
    });
  });

  // The scaffold's e2e file skips until a driver is registered; flooring it reds a fresh app.
  test('e2e is never proposed', async () => {
    await withFloor({ steps: [] }, async (root) => {
      expect(await unflooredStepsProbe(root, [step('e2e', true)])).toEqual([]);
    });
  });

  test('an applies that throws is a step that does not apply here, never a crash', async () => {
    await withFloor(undefined, async (root) => {
      const broken: VerifyStep = {
        ...step('job', true),
        applies: async () => Promise.reject(new TypeError('unreadable')),
      };
      expect(await unflooredStepsProbe(root, [broken])).toEqual([]);
    });
  });

  test('one finding names every step, run first, then the edit that clears it', async () => {
    const [finding, ...rest] = unflooredStepFindings(['live', 'job']);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe(STEP_UNFLOORED);
    expect(finding?.fix.startsWith('x verify --only live,job --json')).toBe(true);
    expect(unflooredStepFindings([])).toEqual([]);
    // The edit the fix names, applied: the floor holds both, and the probe is silent.
    await withFloor({ steps: ['live', 'job'] }, async (root) => {
      expect(await unflooredStepsProbe(root, [step('live', true), step('job', true)])).toEqual([]);
    });
  });

  test('the real step list is asked without spawning', async () => {
    await withFloor({ steps: [] }, async (root) => {
      // An empty root: nothing applies, and nothing was run to find that out.
      expect(await unflooredStepsProbe(root)).toEqual([]);
    });
  });
});
