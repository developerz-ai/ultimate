// A guard's `guardBaseline` in `x.verify.json`, through the `boundaries` step: up to the count its
// findings are notices, above it red with `X_GUARD_OVER_BASELINE`, and a count the tree has fallen
// under is red too, naming the lower number — the baseline only falls.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { VERIFY_STEPS } from './cmd-verify';
import { fixProblem } from './error-contract';
import { exec } from './exec';
import { GUARD_DIR, guardFindings } from './guards';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import {
  GUARD_BASELINE_STALE_CODE,
  GUARD_OVER_BASELINE_CODE,
  judgeGuardBaseline,
} from './verify-guard-baseline';

/** A gating guard reporting `hits` findings. */
const rule = (hits: number): string => `export const guard = {
  summary: 'a rule this app is still bringing its tree under',
  check: () => Array.from({ length: ${String(hits)} }, (_, i) => ({
    code: 'X_APP_RULE',
    cause: \`apps/web/app/a\${String(i)}.ts breaks the rule\`,
    fix: 'x g action a',
  })),
};
`;

const withApp = async (
  guards: Readonly<Record<string, string>>,
  floor: string | undefined,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guards-baseline-'));
  try {
    // The one pin the shipped `runtime-pin` asks of every app, so only the case's guard speaks.
    await Bun.write(join(root, 'package.json'), JSON.stringify({ engines: { bun: '1.4.4' } }));
    for (const [name, contents] of Object.entries(guards)) {
      await Bun.write(join(root, GUARD_DIR, name), contents);
    }
    if (floor !== undefined) await Bun.write(join(root, VERIFY_FLOOR_FILE), floor);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const boundaries = (root: string) =>
  VERIFY_STEPS.find((step) => step.name === 'boundaries')?.run({ root, runner: exec });

const codes = (findings: readonly { readonly code: string }[] | undefined) =>
  (findings ?? []).map((finding) => finding.code);

describe('unit · a guard baseline: notices up to it, red above it, and it only falls', () => {
  test('at the baseline: boundaries is green and every finding is a notice', async () => {
    await withApp(
      { 'no-eval.ts': rule(2) },
      '{"steps":[],"guardBaseline":{"no-eval":2}}',
      async (root) => {
        const outcome = await boundaries(root);
        expect(outcome?.ok).toBe(true);
        expect(outcome?.warnings).toHaveLength(2);
        expect(await guardFindings(root)).toEqual([]);
      },
    );
  });

  test('above the baseline: red, with the count it went over by', async () => {
    await withApp(
      { 'no-eval.ts': rule(3) },
      '{"steps":[],"guardBaseline":{"no-eval":2}}',
      async (root) => {
        const found = await guardFindings(root);
        expect(codes(found)).toEqual([
          'X_APP_RULE',
          'X_APP_RULE',
          'X_APP_RULE',
          GUARD_OVER_BASELINE_CODE,
        ]);
        expect(found.at(-1)?.cause).toContain('reports 3 finding(s)');
      },
    );
  });

  test('under the baseline: red, saying lower your baseline to N', async () => {
    await withApp(
      { 'no-eval.ts': rule(1) },
      '{"steps":[],"guardBaseline":{"no-eval":4}}',
      async (root) => {
        const found = await guardFindings(root);
        expect(codes(found)).toEqual([GUARD_BASELINE_STALE_CODE]);
        expect(found[0]?.fix).toContain('lower your baseline to 1');
        expect(fixProblem(found[0]?.fix ?? '')).toBeUndefined();
      },
    );
  });

  test('a baseline for a guard the app no longer has is stale too', async () => {
    await withApp({}, '{"steps":[],"guardBaseline":{"gone":3}}', async (root) => {
      const found = await guardFindings(root);
      expect(codes(found)).toEqual([GUARD_BASELINE_STALE_CODE]);
      expect(found[0]?.fix).toContain('drop "gone"');
    });
  });

  test('no baseline: every finding fails, exactly as before', async () => {
    await withApp({ 'no-eval.ts': rule(2) }, undefined, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_APP_RULE', 'X_APP_RULE']);
    });
  });

  test('the judgment alone: the key is the file stem', () => {
    const held = [{ code: 'X_APP_RULE', cause: 'c', fix: 'x g action a' }];
    expect(judgeGuardBaseline('guards/no-eval.ts', held, { 'no-eval': 1 })).toEqual({
      findings: [],
      notices: held,
    });
    expect(judgeGuardBaseline('guards/no-eval.ts', held, { other: 1 }).findings).toEqual(held);
  });
});
