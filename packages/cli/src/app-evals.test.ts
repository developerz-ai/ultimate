// Eval coverage and the gate step that enforces it, against a real app written to disk: the
// whole point is that the rule reads the app's own registries, so a fixture that only pretended
// to declare a prompt would prove nothing.

// Bun ships no `Bun.*` equivalent for either: `rm` tears the fixture tree down between runs, and
// `join` builds the host-separator paths it is written to and read from.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetEvals, resetPrompts } from '@ultimat3/ai';
import { checkEvalCoverage } from './app-evals';
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
