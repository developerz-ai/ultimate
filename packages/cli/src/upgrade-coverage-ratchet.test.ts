// The hop's coverage ratchet: a gate red only because the tree now covers more than its floor
// (`X_COVERAGE_FLOOR_STALE`) gets the floor raised to what it measured, never lowered, and the
// `unit` step judged again — one adopter's upgrade went red on a test a codemod wrote.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { CoverageMeasure } from './coverage-floor';
import { coverageFindings, readCoverageFloor } from './coverage-floor';
import {
  measuredUnit,
  raiseCoverageFloor,
  rejudgedVerify,
  staleUnitFloor,
} from './upgrade-coverage-ratchet';
import type { HopGate } from './upgrade-gate';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const WHY = 'islands are covered by e2e';

const app = async (payload: object | undefined): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-upgrade-coverage-'));
  roots.push(root);
  if (payload !== undefined) await Bun.write(join(root, 'x.verify.json'), JSON.stringify(payload));
  return root;
};

const floorIn = async (root: string) =>
  readCoverageFloor(await Bun.file(join(root, 'x.verify.json')).json()).coverage;

const measure = (lines: number, funcs: number): CoverageMeasure => ({
  lines,
  funcs,
  linesHit: 0,
  linesFound: 0,
  funcsHit: 0,
  funcsFound: 0,
  files: 1,
  losses: [],
});

const finding = (step: string | undefined, code: string) => ({
  ...(step === undefined ? {} : { step }),
  code,
  cause: 'c',
  fix: 'f',
});

type Verify = HopGate['verify'];
const verdict = (over: Partial<Verify>): Verify => ({
  ok: false,
  summary: '1 of 21 steps failed',
  failed: ['unit'],
  findings: [finding('unit', 'X_COVERAGE_FLOOR_STALE')],
  ...over,
});

describe('unit · raiseCoverageFloor', () => {
  test('the floor rises to the measured whole numbers, keeps its why, and the gate is green', async () => {
    const root = await app({ steps: ['unit'], coverage: { lines: 69, funcs: 60, why: WHY } });
    expect(await raiseCoverageFloor(root, { lines: 72.3, funcs: 66.1 })).toEqual({
      file: 'x.verify.json',
      measured: { lines: 72.3, funcs: 66.1 },
      from: { lines: 69, funcs: 60 },
      to: { lines: 72, funcs: 66 },
    });
    const floor = await floorIn(root);
    expect(floor).toMatchObject({ lines: 72, funcs: 66, why: WHY });
    const payload = await Bun.file(join(root, 'x.verify.json')).json();
    expect(payload.steps).toEqual(['unit']);
    expect(coverageFindings(measure(72.3, 66.1), floor, { exists: () => true })).toEqual([]);
  });

  test('never lowers: a number measured under its floor keeps the floor', async () => {
    const root = await app({ coverage: { lines: 69, funcs: 70, why: WHY } });
    const raised = await raiseCoverageFloor(root, { lines: 72.3, funcs: 65 });
    expect(raised?.to).toEqual({ lines: 72, funcs: 70 });
    expect(await floorIn(root)).toMatchObject({ lines: 72, funcs: 70 });
  });

  test('a floor that reaches the bar drops its why, as the finding says to', async () => {
    const root = await app({ coverage: { lines: 90, funcs: 90, why: WHY } });
    expect((await raiseCoverageFloor(root, { lines: 97, funcs: 99 }))?.to).toEqual({
      lines: 95,
      funcs: 95,
    });
    const floor = await floorIn(root);
    expect(floor?.why).toBeUndefined();
    expect(coverageFindings(measure(97, 99), floor, { exists: () => true })).toEqual([]);
  });

  test('nothing to raise, no floor, or no file: nothing written', async () => {
    const held = { coverage: { lines: 72, funcs: 66, why: WHY } };
    const root = await app(held);
    expect(await raiseCoverageFloor(root, { lines: 72.3, funcs: 66.1 })).toBeNull();
    expect(await Bun.file(join(root, 'x.verify.json')).json()).toEqual(held);
    expect(await raiseCoverageFloor(await app({ steps: [] }), { lines: 80, funcs: 80 })).toBeNull();
    expect(await raiseCoverageFloor(await app(undefined), { lines: 80, funcs: 80 })).toBeNull();
  });
});

describe('unit · the gate document', () => {
  test('a stale floor is the unit step’s finding, nothing else', () => {
    expect(staleUnitFloor(verdict({}))).toBe(true);
    expect(staleUnitFloor(verdict({ findings: [finding('unit', 'X_COVERAGE_BELOW_FLOOR')] }))).toBe(
      false,
    );
    expect(staleUnitFloor(verdict({ findings: [finding('lint', 'X_COVERAGE_FLOOR_STALE')] }))).toBe(
      false,
    );
  });

  test('the measured numbers are read off the verify document, and only from there', () => {
    const doc = { ok: false, data: { coverage: { unit: { lines: 72.3, funcs: 66.1, files: 9 } } } };
    expect(measuredUnit(`noise\n${JSON.stringify(doc)}`)).toEqual({ lines: 72.3, funcs: 66.1 });
    expect(measuredUnit(JSON.stringify({ ok: false, data: {} }))).toBeUndefined();
    expect(measuredUnit('not json')).toBeUndefined();
  });
});

describe('unit · rejudgedVerify', () => {
  const unitRun = (over: Partial<Verify>): Verify => ({
    ok: true,
    summary: '1 of 1 steps passed',
    failed: [],
    findings: [],
    ...over,
  });

  test('unit alone was red and its re-run is green: the hop is green', () => {
    const judged = rejudgedVerify(verdict({}), unitRun({}));
    expect(judged.ok).toBe(true);
    expect(judged.failed).toEqual([]);
    expect(judged.findings).toEqual([]);
    expect(judged.summary).toContain('1 of 21 steps failed');
  });

  test('another red step keeps the hop red, and its findings stay', () => {
    const judged = rejudgedVerify(
      verdict({
        failed: ['lint', 'unit'],
        findings: [finding('lint', 'X_LINT'), finding('unit', 'X_COVERAGE_FLOOR_STALE')],
      }),
      unitRun({}),
    );
    expect(judged.ok).toBe(false);
    expect(judged.failed).toEqual(['lint']);
    expect(judged.findings.map((one) => one.code)).toEqual(['X_LINT']);
  });

  test('a unit re-run still red stays red, with its own findings', () => {
    const judged = rejudgedVerify(
      verdict({}),
      unitRun({
        ok: false,
        failed: ['unit'],
        findings: [finding('unit', 'X_COVERAGE_BELOW_FLOOR')],
      }),
    );
    expect(judged.ok).toBe(false);
    expect(judged.failed).toEqual(['unit']);
    expect(judged.findings.map((one) => one.code)).toEqual(['X_COVERAGE_BELOW_FLOOR']);
  });

  test('a finding outside every step keeps the hop red', () => {
    const judged = rejudgedVerify(
      verdict({ findings: [finding(undefined, 'X_APP_LOAD'), finding('unit', 'X')] }),
      unitRun({}),
    );
    expect(judged.ok).toBe(false);
  });

  test('a narrowed hop keeps its list of steps owed elsewhere', () => {
    const judged = rejudgedVerify(verdict({ only: ['unit'], notRun: ['e2e'] }), unitRun({}));
    expect(judged.only).toEqual(['unit']);
    expect(judged.notRun).toEqual(['e2e']);
  });
});
