// The hop gate's coverage ratchet, end to end over a scripted installed CLI: a gate red only on
// `X_COVERAGE_FLOOR_STALE` raises the floor in `x.verify.json`, re-runs `unit`, and goes green.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { runHopGate } from './upgrade-gate';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const STALE = { code: 'X_COVERAGE_FLOOR_STALE', cause: 'c', fix: 'f' };

const result = (command: readonly string[], document: object, ok = true): ExecResult => ({
  command,
  code: ok ? 0 : 1,
  ok,
  stdout: JSON.stringify(document),
  stderr: '',
  durationMs: 1,
});

/** The installed CLI: `unit` passes only once the floor on disk is what the gate measured. */
const scripted =
  (root: string, calls: string[], gateSteps: readonly object[]): Runner =>
  async (command) => {
    const args = command.slice(2).join(' ');
    calls.push(args);
    if (args === 'verify --json') {
      const coverage = { unit: { lines: 72.3, funcs: 66.1, files: 9 } };
      return result(
        command,
        { ok: false, summary: 'failed', steps: gateSteps, data: { coverage } },
        false,
      );
    }
    if (args === 'verify --only unit --json') {
      const floor = (await Bun.file(join(root, 'x.verify.json')).json()).coverage;
      const green = floor.lines === 72 && floor.funcs === 66;
      const step = green
        ? { name: 'unit', ok: true }
        : { name: 'unit', ok: false, findings: [STALE] };
      return result(command, { ok: green, summary: 'unit', steps: [step] }, green);
    }
    return result(command, { ok: true });
  };

const app = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-upgrade-gate-coverage-'));
  roots.push(root);
  await Bun.write(
    join(root, 'x.verify.json'),
    JSON.stringify({ coverage: { lines: 69, funcs: 60, why: 'islands' } }),
  );
  return root;
};

describe('unit · runHopGate, a stale coverage floor', () => {
  test('is raised, unit re-runs, and the hop is green', async () => {
    const root = await app();
    const calls: string[] = [];
    const stages: string[] = [];
    const gate = await runHopGate({
      runner: scripted(root, calls, [{ name: 'unit', ok: false, findings: [STALE] }]),
      root,
      onStage: (stage) => stages.push(stage),
    });
    expect(gate.coverageRaised?.to).toEqual({ lines: 72, funcs: 66 });
    expect(gate.verify.ok).toBe(true);
    expect(gate.verify.failed).toEqual([]);
    expect(calls.slice(-2)).toEqual(['verify --json', 'verify --only unit --json']);
    expect(stages.slice(-2)).toEqual(['verify', 'coverage']);
  });

  test('another red step: the floor still rises, the hop stays red on that step', async () => {
    const root = await app();
    const gate = await runHopGate({
      runner: scripted(
        root,
        [],
        [
          { name: 'lint', ok: false, findings: [{ code: 'X_LINT', cause: 'c', fix: 'f' }] },
          { name: 'unit', ok: false, findings: [STALE] },
        ],
      ),
      root,
      onStage: () => undefined,
    });
    expect(gate.coverageRaised).toBeDefined();
    expect(gate.verify.ok).toBe(false);
    expect(gate.verify.failed).toEqual(['lint']);
  });

  test('a gate with no stale floor runs verify once and raises nothing', async () => {
    const root = await app();
    const calls: string[] = [];
    const gate = await runHopGate({
      runner: scripted(root, calls, [{ name: 'lint', ok: false }]),
      root,
      onStage: () => undefined,
    });
    expect(gate.coverageRaised).toBeUndefined();
    expect(calls.filter((call) => call.startsWith('verify'))).toEqual(['verify --json']);
    expect((await Bun.file(join(root, 'x.verify.json')).json()).coverage.lines).toBe(69);
  });
});
