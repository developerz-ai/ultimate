// One gate step per test type, so every type reports on its own line. A test's type is its
// filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`, `*.e2e.test.ts` (or
// any file under an `e2e/` directory), `*.eval.test.ts`. Everything else is a unit test, which is
// why the unit step is the only one that selects by exclusion.
//
// `eval` carries one rule beyond its suite — every prompt must have an eval — so it is the only
// step here that can fail with no test file of its own.

// Bun ships no `Bun.*` equivalent for either: `existsSync` answers whether this root is an app,
// and `join` builds the host-separator path to its config file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkEvalBaselines, checkEvalCoverage, checkEvalRecording } from './app-evals';
import { APP_CONFIG_FILE } from './app-root';
import { countsOf } from './test-counts';
import type { TestFile } from './test-select';
import { discoverTests } from './test-select';
import { defaultWorkers } from './test-workers';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';
import { fromExec, fromFindings } from './verify-step';
import { runParallel } from './verify-test-run';

export const TEST_TYPES = ['unit', 'contract', 'live', 'job', 'e2e', 'eval'] as const;

export type TestType = (typeof TEST_TYPES)[number];

interface TestSuite {
  readonly summary: string;
  /**
   * Substrings `bun test` matches against each file path — a file matching ANY of them is this
   * type, which is exactly how bun reads more than one positional filter (measured: `.contract.
   * test.` + `.job.test.` runs the union of both suites, never the intersection). A list rather
   * than one string because `e2e` is two rules and the bare word `e2e` was neither: it matched any
   * path holding those three characters anywhere, so a future `src/e2e-helpers.test.ts` would join
   * the e2e step and leave the unit step, which selects by exclusion.
   */
  readonly filters: readonly string[];
}

const TYPED_SUFFIXES = '{contract,live,job,e2e,eval}';

const SUITES: Readonly<Record<Exclude<TestType, 'unit'>, TestSuite>> = {
  contract: {
    summary: 'action/query schemas, policy denials, emitted OpenAPI and MCP shapes',
    filters: ['.contract.test.'],
  },
  live: {
    summary: 'live-query snapshots, incremental patches, reconnect deltas',
    filters: ['.live.test.'],
  },
  job: {
    summary: 'step replay, idempotency dedupe, retry/backoff, outbox atomicity',
    filters: ['.job.test.'],
  },
  e2e: {
    // `e2e/`, not `/e2e/`: bun matches a filter against the cwd-relative path and answers
    // `Test filter "/e2e/" had no matches` for the anchored form (bun 1.3.14). The trailing slash
    // is the boundary this can express, and it is the same string `belongsToType` tests with, so
    // the step's argv and the file list can never disagree about what an e2e test is.
    summary: 'the built output, incl. offline and SW update',
    filters: ['e2e/', '.e2e.test.'],
  },
  eval: {
    summary: 'LLM output scored against thresholds',
    filters: ['.eval.test.'],
  },
};

/**
 * Which types run across worker processes, and why the other two cannot.
 *
 * Parallel is safe when the only thing a test file shares with another file is the database, and
 * the database is per worker by construction (`ULTIMATE_TEST_WORKER` → one clone of the migrated
 * template, `@ultimat3/testing`'s `acquireWorkerDatabase`). Every other process-global in this
 * framework — the permission set, the roles, the entity/action/query registries, the error-code
 * titles, the fixture bag — is handled by `--isolate` giving each FILE its own module registry.
 *
 * | Type | Why |
 * |---|---|
 * | `live` | **serial.** A logical replication slot and a publication are named at the Postgres
 * CLUSTER level, not inside a database, and this repo's own feed tests hard-code
 * `x_live_slot` / `x_live_pub` against `TEST_REPLICATION_URL` — the one server, never a per-worker
 * clone. Two workers would race `pg_create_logical_replication_slot` and the loser's failure would
 * read as a flake. A per-worker database does not isolate a cluster-wide object |
 * | `e2e` | **serial.** It runs against the *built output*: one `dist/`, one service-worker
 * registration, one browser profile. There is nothing per-worker to hand it, and the type is
 * seconds at most, so a split would buy a race and no time |
 *
 * The two are named here rather than tested for, because "can this type be sharded?" is a design
 * fact about the type, not something a run can discover about itself.
 */
export const SERIAL_TYPES: readonly TestType[] = ['live', 'e2e'];

const isSerial = (type: TestType): boolean => SERIAL_TYPES.includes(type);

/**
 * Build output, and nested projects that carry their own `x verify`. `examples/**` and
 * `dummy/**` are the second kind: each holds a whole app gated by its own run of this same step
 * list, so collecting them here would report one app failure on two different gates. The patterns
 * are relative to the run's root, so this excludes nothing when the app itself is the root.
 *
 * `dummy/**` was added after the framework gate started running a demo app's tests and disagreeing
 * with `bun run test` — which already excluded it — for no reason a reader could see.
 *
 * Excluded here is not ungated: `scripts/reference-app-gate.ts` runs `x verify` inside each of
 * those apps and blocks on a per-app ratchet. Until 2026-08 that was only true of `examples/**`,
 * and `dummy/social-media-clone` was excluded by this list and gated by nothing.
 */
const NEVER_A_TEST = ['**/dist/**', '**/build/**', '**/examples/**', '**/dummy/**'];

const ignoreFlags = (patterns: readonly string[]): readonly string[] =>
  patterns.map((pattern) => `--path-ignore-patterns=${pattern}`);

/**
 * The substrings that decide a file's type — the same ones the step's `bun test` runs with, so
 * `x test <type>` and the gate's `<type>` step can never disagree about what a contract test is.
 */
export const typeFiltersOf = (type: Exclude<TestType, 'unit'>): readonly string[] =>
  SUITES[type].filters;

/** Unit is everything the typed suites do not claim, so no test can fall between two steps. */
export const testStepCommand = (type: TestType): readonly string[] =>
  type === 'unit'
    ? [
        'bun',
        'test',
        ...ignoreFlags([...NEVER_A_TEST, '**/e2e/**', `**/*.${TYPED_SUFFIXES}.test.*`]),
      ]
    : ['bun', 'test', ...ignoreFlags(NEVER_A_TEST), ...SUITES[type].filters];

/**
 * Whether a step applies and what it runs are now one question with one answer: the file list.
 * They used to be two — a glob for `applies`, `--path-ignore-patterns` for the run — and when they
 * drifted, a suite that lived only under an ignored path made its step apply and then fail with
 * "no test files matched", a red gate reporting a suite that by its own rule is not here.
 *
 * Memoized because `runVerify` asks `applies` and then `run`, and a repeated walk of the whole
 * tree per type is the cost this change exists to remove.
 */
const discovered = new Map<string, readonly TestFile[]>();

const filesFor = async (root: string, type: TestType): Promise<readonly TestFile[]> => {
  const key = `${root}\u0000${type}`;
  const cached = discovered.get(key);
  if (cached !== undefined) return cached;
  const files = await discoverTests(root, undefined, type);
  discovered.set(key, files);
  return files;
};

/** Test seam: a fixture that writes new test files under a root this process already scanned. */
export const resetTestDiscovery = (): void => discovered.clear();

const runSerial = async (ctx: VerifyContext, type: TestType): Promise<StepOutcome> => {
  const command = testStepCommand(type);
  const result = await ctx.runner(command, { cwd: ctx.root });
  return {
    ...fromExec(result, {
      code: 'X_TEST_FAILED',
      cause: `one or more ${type} tests failed`,
      fix: command.join(' '),
    }),
    workers: 1,
    tests: countsOf([result]),
  };
};

const runType = async (ctx: VerifyContext, type: TestType): Promise<StepOutcome> => {
  if (isSerial(type)) return runSerial(ctx, type);
  const files = await filesFor(ctx.root, type);
  if (files.length === 0) return runSerial(ctx, type);
  return runParallel({
    root: ctx.root,
    runner: ctx.runner,
    files,
    workers: ctx.workers ?? defaultWorkers(),
    type,
  });
};

const isApp = (root: string): boolean => existsSync(join(root, APP_CONFIG_FILE));

/**
 * The eval step carries rules beyond "the suite is green": every prompt must have an eval, every
 * eval must have a baseline to gate against, and the run must not be recording. So it is the one
 * test step that applies with no suite of its own — an app whose only prompt has no eval file
 * would otherwise skip this step and report a green gate over untested code.
 */
const evalStep: VerifyStep = {
  name: 'eval',
  summary: SUITES.eval.summary,
  applies: async (ctx) => isApp(ctx.root) || (await filesFor(ctx.root, 'eval')).length > 0,
  async run(ctx) {
    // First, and instead of the suite: under recording every eval writes the numbers it just
    // measured and passes, so running it here would rewrite the committed baselines during the
    // gate — damage a red step does not undo.
    const recording = checkEvalRecording();
    if (recording.length > 0) return fromFindings(recording);
    const declarations = isApp(ctx.root)
      ? [...(await checkEvalCoverage(ctx.root)), ...(await checkEvalBaselines(ctx.root))]
      : [];
    if ((await filesFor(ctx.root, 'eval')).length === 0) return fromFindings(declarations);
    const suite = await runType(ctx, 'eval');
    return {
      ...suite,
      ok: suite.ok && declarations.length === 0,
      findings: [...declarations, ...suite.findings],
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
  return {
    name: type,
    summary: SUITES[type].summary,
    applies: async (ctx) => (await filesFor(ctx.root, type)).length > 0,
    run: (ctx) => runType(ctx, type),
  };
};

/** In cost order: unit needs nothing, e2e needs a build. */
export const TEST_STEPS: readonly VerifyStep[] = TEST_TYPES.map(stepFor);
