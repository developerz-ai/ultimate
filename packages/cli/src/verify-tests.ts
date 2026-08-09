// One `bun test` invocation per test type, so every type reports on its own line of the gate. A
// test's type is its filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`,
// `*.e2e.test.ts` (or any file under an `e2e/` directory), `*.eval.test.ts`. Everything else is a
// unit test, which is why the unit step is the only one that selects by exclusion.
//
// `eval` carries one rule beyond its suite — every prompt must have an eval — so it is the only
// step here that can fail with no test file of its own.

// Bun ships no `Bun.*` equivalent for either: `existsSync` answers whether this root is an app,
// and `join` builds the host-separator path to its config file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkEvalCoverage } from './app-evals';
import { APP_CONFIG_FILE } from './app-root';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';
import { fromExec, fromFindings } from './verify-step';

export const TEST_TYPES = ['unit', 'contract', 'live', 'job', 'e2e', 'eval'] as const;

export type TestType = (typeof TEST_TYPES)[number];

interface TestSuite {
  readonly summary: string;
  /** Substring `bun test` matches against each file path. */
  readonly filter: string;
  /** Globs that decide whether this type exists here at all. */
  readonly globs: readonly string[];
}

const TYPED_SUFFIXES = '{contract,live,job,e2e,eval}';

const SUITES: Readonly<Record<Exclude<TestType, 'unit'>, TestSuite>> = {
  contract: {
    summary: 'action/query schemas, policy denials, emitted OpenAPI and MCP shapes',
    filter: '.contract.test.',
    globs: ['**/*.contract.test.{ts,tsx}'],
  },
  live: {
    summary: 'live-query snapshots, incremental patches, reconnect deltas',
    filter: '.live.test.',
    globs: ['**/*.live.test.{ts,tsx}'],
  },
  job: {
    summary: 'step replay, idempotency dedupe, retry/backoff, outbox atomicity',
    filter: '.job.test.',
    globs: ['**/*.job.test.{ts,tsx}'],
  },
  e2e: {
    summary: 'the built output, incl. offline and SW update',
    filter: 'e2e',
    globs: ['**/*.e2e.test.{ts,tsx}', '**/e2e/**/*.test.{ts,tsx}'],
  },
  eval: {
    summary: 'LLM output scored against thresholds',
    filter: '.eval.test.',
    globs: ['**/*.eval.test.{ts,tsx}'],
  },
};

/**
 * Build output, and nested projects that carry their own `x verify`. `examples/**` is the second
 * kind: the reference app is gated by its own run of this same step list, so collecting it here
 * would report one app failure on two different gates. The patterns are relative to the run's
 * root, so this excludes nothing when the app itself is the root.
 */
const NEVER_A_TEST = ['**/dist/**', '**/build/**', '**/examples/**'];

const ignoreFlags = (patterns: readonly string[]): readonly string[] =>
  patterns.map((pattern) => `--path-ignore-patterns=${pattern}`);

/** Unit is everything the typed suites do not claim, so no test can fall between two steps. */
export const testStepCommand = (type: TestType): readonly string[] =>
  type === 'unit'
    ? [
        'bun',
        'test',
        ...ignoreFlags([...NEVER_A_TEST, '**/e2e/**', `**/*.${TYPED_SUFFIXES}.test.*`]),
      ]
    : ['bun', 'test', ...ignoreFlags(NEVER_A_TEST), SUITES[type].filter];

/**
 * Whether a step applies has to be decided by the same rule that decides what it runs. When the
 * two drifted, a suite that lived only under an ignored path made its step apply and then fail
 * with "no test files matched" — a red gate reporting a suite that, by its own rule, is not here.
 */
const NEVER_A_TEST_GLOBS = NEVER_A_TEST.map((pattern) => new Bun.Glob(pattern));

const ignoredPath = (path: string): boolean =>
  path.includes('node_modules') || NEVER_A_TEST_GLOBS.some((glob) => glob.match(path));

const exists = async (root: string, globs: readonly string[]): Promise<boolean> => {
  for (const pattern of globs) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      if (!ignoredPath(path)) return true;
    }
  }
  return false;
};

const runType = async (ctx: VerifyContext, type: TestType): Promise<StepOutcome> => {
  const command = testStepCommand(type);
  const result = await ctx.runner(command, { cwd: ctx.root });
  return fromExec(result, {
    code: 'X_TEST_FAILED',
    cause: `one or more ${type} tests failed`,
    fix: command.join(' '),
  });
};

const isApp = (root: string): boolean => existsSync(join(root, APP_CONFIG_FILE));

/**
 * The eval step carries one rule beyond "the suite is green": every prompt must have an eval. So
 * it is the one test step that applies with no suite of its own — an app whose only prompt has no
 * eval file would otherwise skip this step and report a green gate over untested code.
 */
const evalStep: VerifyStep = {
  name: 'eval',
  summary: SUITES.eval.summary,
  applies: async (ctx) => isApp(ctx.root) || (await exists(ctx.root, SUITES.eval.globs)),
  async run(ctx) {
    const coverage = isApp(ctx.root) ? await checkEvalCoverage(ctx.root) : [];
    if (!(await exists(ctx.root, SUITES.eval.globs))) return fromFindings(coverage);
    const suite = await runType(ctx, 'eval');
    return {
      ok: suite.ok && coverage.length === 0,
      findings: [...coverage, ...suite.findings],
      ...(suite.output === undefined ? {} : { output: suite.output }),
    };
  },
};

const stepFor = (type: TestType): VerifyStep => {
  if (type === 'unit') {
    return {
      name: 'unit',
      summary: 'pure logic — no database, no network',
      run: (ctx) => runType(ctx, 'unit'),
    };
  }
  if (type === 'eval') return evalStep;
  const suite = SUITES[type];
  return {
    name: type,
    summary: suite.summary,
    applies: (ctx) => exists(ctx.root, suite.globs),
    run: (ctx) => runType(ctx, type),
  };
};

/** In cost order: unit needs nothing, e2e needs a build. */
export const TEST_STEPS: readonly VerifyStep[] = TEST_TYPES.map(stepFor);
