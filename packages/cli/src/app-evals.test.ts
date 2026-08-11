// Eval coverage and the gate step that enforces it, against a real app written to disk: the
// whole point is that the rule reads the app's own registries, so a fixture that only pretended
// to declare a prompt would prove nothing.

// Bun ships no `Bun.*` equivalent for either: `rm` tears the fixture tree down between runs, and
// `join` builds the host-separator paths it is written to and read from.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RECORD_ENV, resetEvals, resetPrompts } from '@ultimat3/ai';
import { checkEvalBaselines, checkEvalCoverage, checkEvalRecording } from './app-evals';
import { resetAppLoad } from './app-load';
import type { VerifyContext } from './verify-step';
import { TEST_STEPS } from './verify-tests';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve through the same tsconfig
// paths the framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const COVERED = join(import.meta.dir, '..', '.eval-covered-fixture');
const BARE = join(import.meta.dir, '..', '.eval-bare-fixture');

const promptModule = (id: string): string => `import { definePrompt } from '@ultimat3/ai';

export const summarize = definePrompt({
  id: '${id}',
  version: '3',
  template: 'Summarise {{body}}',
});
`;

const evalModule = `import { defineEval, exact } from '@ultimat3/ai';
import { summarize } from './summarize';

export const summarizeEval = defineEval({
  name: 'summarize',
  prompt: summarize,
  baseline: import.meta.resolve('./summarize.baseline.json'),
  tolerance: 0.05,
  scorers: [exact],
  cases: [{ name: 'one', vars: { body: 'a post' }, expected: 'a post' }],
});
`;

const APP_CONFIG = 'export const config = {};\n';

const FIXTURES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [COVERED]: {
    'app.config.ts': APP_CONFIG,
    'apps/web/app/posts/prompts/summarize.ts': promptModule('posts.summarize'),
    'apps/web/app/posts/prompts/summarize.evals.ts': evalModule,
  },
  [BARE]: {
    'app.config.ts': APP_CONFIG,
    'apps/web/app/posts/prompts/summarize.ts': promptModule('bare.summarize'),
  },
};

/** The baseline the COVERED fixture's eval declares — written and removed by the tests below. */
const COVERED_BASELINE = join(COVERED, 'apps/web/app/posts/prompts/summarize.baseline.json');

const RECORDED = `${JSON.stringify(
  { eval: 'summarize', prompt: 'posts.summarize@3', promptHash: 'abc123', score: 1, cases: {} },
  null,
  2,
)}\n`;

const reset = (): void => {
  resetPrompts();
  resetEvals();
  resetAppLoad();
};

beforeAll(async () => {
  for (const [root, files] of Object.entries(FIXTURES)) {
    await rm(root, { recursive: true, force: true });
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
  }
  reset();
});

afterAll(async () => {
  for (const root of Object.keys(FIXTURES)) await rm(root, { recursive: true, force: true });
  reset();
});

const ctxFor = (root: string): VerifyContext => ({
  root,
  runner: async () => ({
    command: ['bun', 'test'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
});

const evalStep = TEST_STEPS.find((step) => step.name === 'eval');

const causes = (findings: readonly { readonly cause: string }[]): string =>
  findings.map((finding) => finding.cause).join(' | ');

// The prompt registry is process-global — one app per `x verify`, and a module imported once per
// process — so these tests never reset it between loads: they assert on which prompts are named,
// not on how many, and both fixtures stay loaded for the whole file.
describe('unit · a prompt with no eval fails the gate', () => {
  test('a prompt an eval names is covered', async () => {
    expect(causes(await checkEvalCoverage(COVERED))).not.toContain('posts.summarize');
  });

  test('coverage names the prompt and the declaration that would fix it', async () => {
    const findings = (await checkEvalCoverage(BARE)).filter((finding) =>
      finding.cause.includes('bare.summarize'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_EVAL_MISSING');
    expect(findings[0]?.cause).toContain('bare.summarize@3');
    expect(findings[0]?.fix).toContain('defineEval(');
    expect(findings[0]?.at).toBe('bare.summarize@3');
  });

  test('the step applies with no eval suite at all, and fails on the missing eval', async () => {
    // Without this the step would skip — and a skipped step reads as a green gate over a prompt
    // nothing evaluates, which is exactly the hole the rule exists to close.
    expect(await evalStep?.applies?.(ctxFor(BARE))).toBe(true);
    const outcome = await evalStep?.run(ctxFor(BARE));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.findings.map((finding) => finding.code)).toContain('X_EVAL_MISSING');
  });

  test('a green suite does not rescue an uncovered prompt', async () => {
    await Bun.write(join(BARE, 'apps/web/app/posts/prompts/other.eval.test.ts'), 'export {};\n');
    try {
      const outcome = await evalStep?.run(ctxFor(BARE));
      // The runner in `ctxFor` reports every suite as passing; the coverage finding still fails
      // the step, because the two rules are independent halves of one gate.
      expect(outcome?.ok).toBe(false);
      expect(outcome?.findings.map((finding) => finding.code)).toContain('X_EVAL_MISSING');
    } finally {
      await rm(join(BARE, 'apps/web/app/posts/prompts/other.eval.test.ts'), { force: true });
    }
  });

  test('outside an app with no eval suite the step is skipped, never silently passed', async () => {
    expect(await evalStep?.applies?.(ctxFor(import.meta.dir))).toBe(false);
  });
});

// A `defineEval` proves a prompt is named, never that anything measured it. The COVERED fixture
// declares one and records nothing, which is exactly the state the gate has to call red.
describe('unit · an eval with no baseline gates on nothing', () => {
  const forSummarize = (findings: readonly { readonly at?: string }[]) =>
    findings.filter((finding) => finding.at === 'summarize');

  test('a declared eval whose baseline was never recorded fails the gate', async () => {
    const findings = forSummarize(await checkEvalBaselines(COVERED));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'X_EVAL_BASELINE_MISSING' });
  });

  test('a recorded baseline satisfies it', async () => {
    await Bun.write(COVERED_BASELINE, RECORDED);
    try {
      expect(forSummarize(await checkEvalBaselines(COVERED))).toEqual([]);
    } finally {
      await rm(COVERED_BASELINE, { force: true });
    }
  });

  test('a baseline that cannot be read is not treated as absent', async () => {
    await Bun.write(COVERED_BASELINE, '{ "eval": "summarize" }\n');
    try {
      const findings = forSummarize(await checkEvalBaselines(COVERED));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ code: 'X_EVAL_BASELINE_INVALID' });
    } finally {
      await rm(COVERED_BASELINE, { force: true });
    }
  });
});

// Recording is the one flag that makes every eval pass by definition. A gate run that inherited
// it would be green over numbers it wrote itself — and would leave the rewritten baselines behind.
describe('unit · the gate refuses to run while recording', () => {
  const recordingCtx = (): { ctx: VerifyContext; ran: string[][] } => {
    const ran: string[][] = [];
    return {
      ran,
      ctx: {
        root: COVERED,
        runner: async (command) => {
          ran.push([...command]);
          return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
        },
      },
    };
  };

  const whileRecording = async <T>(run: () => Promise<T>): Promise<T> => {
    Bun.env[RECORD_ENV] = '1';
    try {
      return await run();
    } finally {
      delete Bun.env[RECORD_ENV];
    }
  };

  test('recording off is not a finding', () => {
    expect(checkEvalRecording()).toEqual([]);
  });

  test('recording names the variable and the command that gates instead', async () => {
    const findings = await whileRecording(async () => checkEvalRecording());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_EVAL_RECORDING');
    expect(findings[0]?.cause).toContain(RECORD_ENV);
    expect(findings[0]?.fix).toBe(`env -u ${RECORD_ENV} x verify`);
  });

  test('the step fails and never runs the suite, so no baseline is rewritten', async () => {
    const { ctx, ran } = recordingCtx();
    const outcome = await whileRecording(async () => evalStep?.run(ctx));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.findings.map((finding) => finding.code)).toEqual(['X_EVAL_RECORDING']);
    // The rewrite is the half a red step would not undo, so the refusal has to come first.
    expect(ran).toEqual([]);
  });
});
