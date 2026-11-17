// `skipCeiling`: a step that skipped more than `x.verify.json` allows is red where the verdict is —
// a whole `x verify` under `CI`, and `x verify merge` on the summed shards — and a laptop with `CI`
// unset stays green. The probe that found it: 9 of 17 contract tests behind a typo'd env var read
// `"ok":true … "tests":{"ran":8,"skipped":9}`.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { TestCounts } from './test-counts';
import { floorProblemFindings, parseVerifyFloor, VERIFY_FLOOR_FILE } from './verify-floor';
import { mergeParts } from './verify-merge';
import { runVerify } from './verify-run';
import { shardFiles } from './verify-shard';
import { inCi, judgeSkips } from './verify-skip-ceiling';
import type { VerifyContext, VerifyStep } from './verify-step';

const DECLARED = ['lint', 'unit', 'contract'];
/** A merge refuses a declared step no part carries, so its world is the one step under test. */
const MERGED = ['contract'];
const PROBE: TestCounts = { ran: 8, skipped: 9 };

describe('unit · the skipCeiling key', () => {
  test('a step it runs and a whole number of tests, zero included', () => {
    const floor = parseVerifyFloor(
      JSON.stringify({ steps: [], skipCeiling: { contract: 9, unit: 0 } }),
      DECLARED,
    );
    expect(floor.skipCeiling).toEqual({ contract: 9, unit: 0 });
    expect(floor.problems).toEqual([]);
  });

  test('a non-number, a negative, an unknown step and a non-object are X_CONFIG_INVALID', () => {
    const floor = parseVerifyFloor(
      JSON.stringify({ steps: [], skipCeiling: { contract: '9', unit: -1, deploy: 1 } }),
      DECLARED,
    );
    expect(floor.skipCeiling).toBeUndefined();
    const findings = floorProblemFindings(floor);
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_CONFIG_INVALID',
      'X_CONFIG_INVALID',
      'X_CONFIG_INVALID',
    ]);
    expect(findings[0]?.fix).toStartWith('x verify --json');
    expect(findings[0]?.fix).toContain('"skipCeiling"');
    const flat = parseVerifyFloor(JSON.stringify({ steps: [], skipCeiling: [3] }), DECLARED);
    expect(flat.problems).toEqual(['"skipCeiling" is not an object of { "<step>": tests }']);
  });
});

describe('unit · the verdict on one step', () => {
  test('over the ceiling is red, at it is green', () => {
    const over = judgeSkips('contract', PROBE, { contract: 8 });
    expect(over.findings.map((finding) => finding.code)).toEqual(['X_VERIFY_SKIPS_OVER_CEILING']);
    expect(over.findings[0]?.fix).toStartWith('x test contract --json');
    expect(judgeSkips('contract', PROBE, { contract: 9 }).findings).toEqual([]);
  });

  test('no ceiling is green, and names the number to write', () => {
    const none = judgeSkips('contract', PROBE, undefined);
    expect(none.findings).toEqual([]);
    expect(none.warnings).toEqual([
      'contract skipped 9 of 17 test(s): hold it with "skipCeiling": { "contract": 9 } in x.verify.json',
    ]);
    expect(judgeSkips('contract', { ran: 3, skipped: 0 }, undefined).warnings).toEqual([]);
  });

  test("nothing ran is the floor's question, not this one's", () => {
    expect(judgeSkips('contract', { ran: 0, skipped: 4 }, { contract: 0 })).toEqual({
      findings: [],
      warnings: [],
    });
  });

  test('CI is set unless it is absent, empty, false or 0', () => {
    expect(inCi({ CI: 'true' })).toBe(true);
    expect(inCi({ CI: '1' })).toBe(true);
    for (const off of [undefined, '', 'false', '0']) expect(inCi({ CI: off })).toBe(false);
  });
});

const contractStep = (tests: TestCounts): VerifyStep => ({
  name: 'contract',
  summary: 'contract',
  run: async () => ({ ok: true, findings: [], tests }),
});

const runner: VerifyContext['runner'] = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const runIn = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<Awaited<ReturnType<typeof runVerify>>> => {
  const root = await mkdtemp(join(tmpdir(), 'x-skip-ceiling-'));
  try {
    await Bun.write(
      join(root, VERIFY_FLOOR_FILE),
      JSON.stringify({ steps: [], skipCeiling: { contract: 2 } }),
    );
    return await runVerify([contractStep(PROBE)], { root, runner, env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · a whole x verify', () => {
  test('under CI, over the ceiling, the step is red', async () => {
    const result = await runIn({ CI: 'true' });
    expect(result.ok).toBe(false);
    const contract = result.steps?.find((step) => step.name === 'contract');
    expect(contract?.findings.map((finding) => finding.code)).toEqual([
      'X_VERIFY_SKIPS_OVER_CEILING',
    ]);
  });

  test('with CI unset it is a dev loop, and green', async () => {
    const result = await runIn({});
    expect(result.ok).toBe(true);
  });
});

describe('unit · x verify merge judges the SUM of the shards', () => {
  const FILES = ['a.test.ts', 'b.test.ts'];
  const shard = (index: number, tests: TestCounts) => ({
    name: 'contract',
    ok: true,
    durationMs: 1,
    skipped: false,
    findings: [],
    tests,
    shard: shardFiles(FILES, { index, total: 2 }),
  });
  const parts = [
    { file: 'c1.json', durationMs: 1, steps: [shard(1, { ran: 4, skipped: 2 })] },
    { file: 'c2.json', durationMs: 1, steps: [shard(2, { ran: 4, skipped: 2 })] },
  ];

  test('two shards each under the ceiling, together over it, are red', () => {
    const result = mergeParts(
      parts,
      { steps: [], skipCeiling: { contract: 3 }, problems: [] },
      MERGED,
    );
    expect(result.ok).toBe(false);
    const codes = (result.steps ?? []).flatMap((step) => step.findings.map((f) => f.code));
    expect(codes).toContain('X_VERIFY_SKIPS_OVER_CEILING');
  });

  test('the sum at the ceiling is green', () => {
    const result = mergeParts(
      parts,
      { steps: [], skipCeiling: { contract: 4 }, problems: [] },
      MERGED,
    );
    expect(result.ok).toBe(true);
  });
});
