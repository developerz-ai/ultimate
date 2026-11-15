// A run's zero-check steps, end to end: each is named with its reason in `--json` and the human
// lines, a strict floor turns an unexcused one red, and a floor that is not strict warns instead.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive, and `rm` owns the throwaway root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { msg } from './messages';
import { renderHuman } from './output';
import { VERIFY_STEPS } from './verify-checks';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { runVerify } from './verify-run';
import { appliesReason, stepsWithAppliesReason } from './verify-skip-reason';
import type { VerifyContext, VerifyStep } from './verify-step';
import { STRICT_UNRUN_CODE } from './verify-strict';

const runner: VerifyContext['runner'] = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const STEPS: readonly VerifyStep[] = [
  { name: 'lint', summary: 'lint', run: async () => ({ ok: true, findings: [] }) },
  {
    name: 'e2e',
    summary: 'e2e',
    applies: async () => false,
    run: async () => ({ ok: true, findings: [] }),
  },
  {
    name: 'live',
    summary: 'live',
    run: async () => ({ ok: true, findings: [], tests: { ran: 0, skipped: 2 } }),
  },
];

interface Data {
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly skipReasons?: Readonly<Record<string, string>>;
  readonly unwaived?: readonly string[];
}

const withFloor = async (
  floor: string | undefined,
  assert: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-strict-'));
  try {
    if (floor !== undefined) await Bun.write(join(root, VERIFY_FLOOR_FILE), floor);
    await assert(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('strict: x verify names every step that ran no check', () => {
  test('each zero-check step is "skipped: <reason>" in --json and in the human lines', async () => {
    await withFloor(undefined, async (root) => {
      const result = await runVerify(STEPS, { root, runner });
      const data = result.data as unknown as Data;
      expect(data.skipReasons).toEqual({
        e2e: appliesReason('e2e'),
        live: msg('cli.verify.allSkipped', { skipped: 2 }),
      });
      expect(renderHuman(result)).toContain(
        msg('cli.verify.skip.line', { step: 'e2e', reason: appliesReason('e2e') }),
      );
    });
  });

  test('a floor that is not strict warns, naming the steps — and stays green', async () => {
    await withFloor('{"steps":["lint"]}', async (root) => {
      const result = await runVerify(STEPS, { root, runner });
      expect(result.ok).toBe(true);
      expect((result.data as unknown as Data).unwaived).toEqual(['e2e', 'live']);
      expect(result.lines?.at(-1)).toBe(msg('cli.verify.unwaived', { names: 'e2e, live' }));
    });
  });

  test('a strict floor missing a step fails it without its why', async () => {
    await withFloor(
      '{"steps":["lint"],"strict":true,"skip":{"live":"no database here"}}',
      async (root) => {
        const result = await runVerify(STEPS, { root, runner });
        expect(result.ok).toBe(false);
        const data = result.data as unknown as Data;
        expect(data.failed).toEqual(['e2e']);
        expect(data.skipped).toEqual(['live']);
        expect(data.unwaived).toBeUndefined();
        const e2e = result.steps?.find((step) => step.name === 'e2e');
        expect(e2e?.findings.map((finding) => finding.code)).toEqual([STRICT_UNRUN_CODE]);
      },
    );
  });

  /** A `live` step whose run reports these counts, or no counts at all, or a shard's slice. */
  const live = (outcome: Partial<Awaited<ReturnType<VerifyStep['run']>>>): VerifyStep[] => [
    { name: 'live', summary: 'live', run: async () => ({ ok: true, findings: [], ...outcome }) },
  ];
  const EXCUSED = '{"steps":[],"strict":true,"skip":{"live":"no database here"}}';

  test('a why over a suite that ran tests is stale, and the step says so', async () => {
    await withFloor(EXCUSED, async (root) => {
      const result = await runVerify(live({ tests: { ran: 4, skipped: 0 } }), { root, runner });
      expect(result.steps?.[0]?.warnings).toEqual([
        msg('cli.verify.waiverStale', { step: 'live' }),
      ]);
    });
  });

  test('a --shard slice that ran tests never calls the why stale: merge judges the sum', async () => {
    await withFloor(EXCUSED, async (root) => {
      const shard = { index: 1, total: 2, corpusHash: 'h', files: ['a.live.test.ts'] };
      const result = await runVerify(live({ tests: { ran: 4, skipped: 0 }, shard }), {
        root,
        runner,
      });
      expect(result.steps?.[0]?.warnings).toBeUndefined();
    });
  });

  test('a --changed run that spawned nothing never calls the why stale', async () => {
    await withFloor(EXCUSED, async (root) => {
      const result = await runVerify(live({ workers: 0 }), { root, runner });
      expect(result.steps?.[0]?.warnings).toBeUndefined();
    });
  });

  test('every step with an applies has a reason of its own', () => {
    const withApplies = VERIFY_STEPS.filter((step) => step.applies !== undefined).map(
      (step) => step.name,
    );
    expect([...stepsWithAppliesReason()].sort()).toEqual([...withApplies].sort());
  });
});
