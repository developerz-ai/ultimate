// One `bun test` invocation per test type, so every type reports on its own line of the gate. A
// test's type is its filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`,
// `*.e2e.test.ts` (or any file under an `e2e/` directory), `*.eval.test.ts`. Everything else is a
// unit test, which is why the unit step is the only one that selects by exclusion.

import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';
import { fromExec } from './verify-step';

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

const NEVER_A_TEST = ['**/dist/**', '**/build/**'];

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

const exists = async (root: string, globs: readonly string[]): Promise<boolean> => {
  for (const pattern of globs) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      if (!path.includes('node_modules')) return true;
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

const stepFor = (type: TestType): VerifyStep => {
  if (type === 'unit') {
    return {
      name: 'unit',
      summary: 'pure logic — no database, no network',
      run: (ctx) => runType(ctx, 'unit'),
    };
  }
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
