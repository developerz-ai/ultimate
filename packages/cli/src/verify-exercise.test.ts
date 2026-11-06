// The `exercise` gate step: placed after `job`, skipped outside an app, and red on exactly what the
// `x exercise --json` child reports. A recording runner stands in for the child, so each case
// asserts what was spawned and what reached the step.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case is a fresh tree.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import type { ExecResult, Runner } from './exec';
import { VERIFY_STEPS } from './verify-checks';
import { exerciseStep, verifyExerciseCommand } from './verify-exercise';
import { VERIFY_STEP_NAMES } from './verify-step';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tree = async (app: boolean): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'verify-exercise-'));
  dirs.push(root);
  if (app) await Bun.write(join(root, APP_CONFIG_FILE), 'export default {};\n');
  return root;
};

const result = (command: readonly string[], code: number, stdout: string): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 1,
});

const UNREACHED = {
  code: 'X_CONTRACT_EXERCISE_UNREACHED',
  cause: 'action publishPost never reached its handler: X_POST_NOT_FOUND',
  fix: "paste publishPost: { input: { postId: '<id>' } } into apps/web/exercise.ts, then x exercise publishPost --json",
  docs: 'https://example.invalid',
  at: 'apps/web/exercise.ts',
};

const recording = (code: number, stdout: string) => {
  const calls: { command: readonly string[]; cwd: string }[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    return result(command, code, stdout);
  };
  return { calls, runner };
};

describe('unit · the exercise step', () => {
  test('sits directly after job, in the names and in the step list alike', () => {
    const at = VERIFY_STEP_NAMES.indexOf('exercise');
    expect(VERIFY_STEP_NAMES[at - 1]).toBe('job');
    expect(VERIFY_STEPS.map((step) => step.name)).toEqual([...VERIFY_STEP_NAMES]);
  });

  test('is skipped outside an app, never passed about nothing', async () => {
    expect(
      await exerciseStep.applies?.({ root: await tree(false), runner: recording(0, '').runner }),
    ).toBe(false);
    expect(
      await exerciseStep.applies?.({ root: await tree(true), runner: recording(0, '').runner }),
    ).toBe(true);
  });

  test('spawns x exercise --json once, from the root, and a clean pass is green', async () => {
    const root = await tree(true);
    const { calls, runner } = recording(
      0,
      JSON.stringify({ ok: true, findings: [], summary: 's' }),
    );
    const outcome = await exerciseStep.run({ root, runner });
    expect(calls).toEqual([{ command: verifyExerciseCommand(), cwd: root }]);
    expect(calls[0]?.command.slice(-2)).toEqual(['exercise', '--json']);
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toEqual([]);
  });

  test('an unreached primitive is red with the child’s own finding, override and all', async () => {
    const root = await tree(true);
    const doc = { ok: false, summary: '1 unreached', findings: [UNREACHED] };
    const outcome = await exerciseStep.run({
      root,
      runner: recording(1, JSON.stringify(doc)).runner,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toEqual([UNREACHED]);
  });

  test('a child that exits non-zero with findings it cannot state is still red, never green', async () => {
    const root = await tree(true);
    const outcome = await exerciseStep.run({
      root,
      runner: recording(1, 'Segmentation fault\n').runner,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['X_CLI_UNEXPECTED']);
    expect(outcome.findings[0]?.fix).toBe('x exercise --json');
  });

  test('a document that says ok:false is red even on exit 0, under X_CLI_UNEXPECTED', async () => {
    const root = await tree(true);
    const doc = JSON.stringify({ ok: false, summary: 'odd', findings: [] });
    const outcome = await exerciseStep.run({ root, runner: recording(0, doc).runner });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['X_CLI_UNEXPECTED']);
  });
});
