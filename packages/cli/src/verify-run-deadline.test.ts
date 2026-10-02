// A step that hangs fails BY NAME and leaves no process behind, and every finished step is told
// to the caller as it finishes — the two halves of #589, driven through the real runner.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the floor file is a real file in a real root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import type { StepResult } from './output';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { runVerify } from './verify-run';
import type { StepTimeoutMeta } from './verify-stalled';
import type { VerifyStep } from './verify-step';

const MARK = 'ULTIMATE_DEADLINE_TEST_MARK';

/** Live processes started with `MARK=<mark>` — what a hung step would leave behind. */
async function marked(mark: string): Promise<readonly number[]> {
  const pids: number[] = [];
  for await (const entry of new Bun.Glob('[0-9]*').scan({ cwd: '/proc', onlyFiles: false })) {
    const environ = await Bun.file(`/proc/${entry}/environ`)
      .text()
      .catch(() => '');
    // A killed child is a zombie until reaped, with an empty environ: only the living match.
    if (environ.split('\0').includes(`${MARK}=${mark}`)) pids.push(Number(entry));
  }
  return pids;
}

const goneSoon = async (mark: string): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    if ((await marked(mark)).length === 0) return true;
    await Bun.sleep(20);
  }
  return false;
};

const ok = (name: VerifyStep['name'], ran: string[]): VerifyStep => ({
  name,
  summary: name,
  run: async () => {
    ran.push(name);
    return { ok: true, findings: [] };
  },
});

/** Hangs on a child, and — like a batch loop — starts another the moment the first returns. */
const hangs = (name: VerifyStep['name'], mark: string, after: string[]): VerifyStep => ({
  name,
  summary: 'hangs on its child',
  run: async (ctx) => {
    const options = { cwd: process.cwd(), env: { [MARK]: mark } };
    await ctx.runner(['sh', '-c', 'sleep 300 & sleep 300'], options);
    const second = await ctx.runner(['sleep', '300'], options);
    after.push(second.stderr);
    return { ok: true, findings: [] };
  },
});

describe('a step past its deadline', () => {
  test('fails by name, kills every process it started, and the steps after it still run', async () => {
    const mark = crypto.randomUUID();
    const ran: string[] = [];
    const after: string[] = [];
    const result = await runVerify(
      [ok('typecheck', ran), hangs('lint', mark, after), ok('drift', ran)],
      { root: '/nowhere', runner: exec, stepTimeoutMs: { lint: 400 }, command: 'bun run verify' },
    );
    expect(ran).toEqual(['typecheck', 'drift']);
    expect(result.ok).toBe(false);
    const lint = result.steps?.find((step) => step.name === 'lint');
    expect(lint?.ok).toBe(false);
    expect(lint?.findings.map((finding) => finding.code)).toEqual(['X_VERIFY_STEP_TIMEOUT']);
    expect(lint?.findings[0]?.cause).toContain('step "lint" did not finish within its 400 ms');
    expect(lint?.findings[0]?.cause).toMatch(/[2-9] process\(es\) it had started were killed/);
    expect(lint?.findings[0]?.fix).toStartWith('bun run verify --only lint --json');
    expect(lint?.durationMs).toBeGreaterThanOrEqual(400);
    expect(lint?.durationMs).toBeLessThan(5_000);
    // No orphan: the shell, both sleepers, and the child the step tried to start afterwards.
    expect(await goneSoon(mark)).toBe(true);
    await Bun.sleep(50);
    expect(after).toEqual(['not started: the step is past its deadline']);
    expect(await marked(mark)).toEqual([]);
  });

  test('a stuck test file is NAMED: the cause says which, the fix runs it, --json carries it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-verify-stuck-'));
    try {
      const passing =
        "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n";
      for (const name of ['a', 'b', 'c']) await Bun.write(join(root, `${name}.test.ts`), passing);
      // Synchronous, so bun's own per-test timeout never fires: the hang only the step deadline ends.
      await Bun.write(
        join(root, 'stuck.test.ts'),
        "import { test } from 'bun:test';\ntest('spins', () => {\n  for (;;) {}\n});\n",
      );
      const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'stuck.test.ts'];
      const suite: VerifyStep = {
        name: 'unit',
        summary: 'one file never finishes',
        run: async (ctx) => {
          await ctx.runner(['bun', 'test', '--parallel=2', ...files], {
            cwd: root,
            // An agent's shell sets these, and bun then prints no line for a passing file.
            env: { CLAUDECODE: undefined, AGENT: undefined, REPL_ID: undefined },
          });
          return { ok: true, findings: [] };
        },
      };
      const result = await runVerify([suite], {
        root,
        runner: exec,
        stepTimeoutMs: { unit: 4_000 },
        command: 'bun run verify',
      });
      const step = result.steps?.[0];
      const [finding] = step?.findings ?? [];
      expect(finding?.code).toBe('X_VERIFY_STEP_TIMEOUT');
      expect(finding?.cause).toContain(
        'still running when it was stopped: stuck.test.ts (bun test',
      );
      expect(finding?.fix).toStartWith('bun test stuck.test.ts   # ');
      expect(finding?.at).toBe('stuck.test.ts');
      // The finding's `meta` is a JSON record on the wire; this code's is `StepTimeoutMeta`.
      const meta = finding?.meta as StepTimeoutMeta | undefined;
      expect(meta?.inFlight).toEqual([
        {
          command: 'bun test --parallel=2',
          files: 4,
          workers: 2,
          unreported: ['stuck.test.ts'],
          named: true,
        },
      ]);
      // The coordinator and the one worker still holding a file — what CI reported as a bare "2".
      const killed = JSON.stringify(meta?.killed);
      expect(killed).toContain('bun test --parallel=2 a.test.ts');
      expect(killed).toContain('--test-worker');
      // What the run had printed rides on the step, so a red gate shows the files that DID finish.
      expect(step?.output).toContain('a.test.ts:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('a step that hangs in this process is failed the same way, with nothing to kill', async () => {
    const never: VerifyStep = {
      name: 'filesize',
      summary: 'never settles',
      run: () => new Promise(() => undefined),
    };
    const result = await runVerify([never], {
      root: '/nowhere',
      runner: exec,
      stepTimeoutMs: { filesize: 30 },
    });
    const [finding] = result.steps?.[0]?.findings ?? [];
    expect(finding?.code).toBe('X_VERIFY_STEP_TIMEOUT');
    expect(finding?.cause).toContain('0 process(es)');
    expect(finding?.fix).toStartWith('x verify --only filesize --json');
  });

  test('x.verify.json states a step’s own deadline, and a step inside it is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-verify-deadline-'));
    try {
      await Bun.write(
        join(root, VERIFY_FLOOR_FILE),
        JSON.stringify({ steps: [], stepTimeoutMs: { filesize: 40 } }),
      );
      const slow = (name: VerifyStep['name']): VerifyStep => ({
        name,
        summary: 'takes 150 ms',
        run: async () => {
          await Bun.sleep(150);
          return { ok: true, findings: [] };
        },
      });
      const result = await runVerify([slow('filesize'), slow('lint')], { root, runner: exec });
      expect(result.steps?.map((step) => [step.name, step.ok])).toEqual([
        ['filesize', false],
        ['lint', true],
      ]);
      expect(result.steps?.[0]?.findings[0]?.cause).toContain('40 ms');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('onStep', () => {
  test('is told each step as it finishes, with the result the table will carry', async () => {
    const told: StepResult[] = [];
    const ran: string[] = [];
    const skipped: VerifyStep = { ...ok('e2e', ran), applies: async () => false };
    const result = await runVerify([ok('typecheck', ran), skipped, ok('drift', ran)], {
      root: '/nowhere',
      runner: exec,
      onStep: (step) => {
        // Told when the step FINISHES: the next one has not started yet.
        told.push(step);
        expect(ran.length).toBeLessThanOrEqual(told.length);
      },
    });
    expect(told.map((step) => step.name)).toEqual(['typecheck', 'e2e', 'drift']);
    expect(told).toEqual([...(result.steps ?? [])]);
    expect(told[1]?.skipped).toBe(true);
  });

  test('a listener that throws does not take the gate down with it', async () => {
    const ran: string[] = [];
    const result = await runVerify([ok('typecheck', ran), ok('drift', ran)], {
      root: '/nowhere',
      runner: exec,
      onStep: () => {
        throw new TypeError('stderr is closed');
      },
    });
    expect(ran).toEqual(['typecheck', 'drift']);
    expect(result.ok).toBe(true);
  });
});
