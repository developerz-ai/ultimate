// One gate step per test type, so every type reports on its own line. A test's type is its
// filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`, `*.e2e.test.ts`,
// `*.eval.test.ts` — and only then the `e2e/` directory it sits in, which is why `OWNERSHIP`
// (`verify-test-command.ts`) is an ordered list. Everything else is a unit test, selected by exclusion.
//
// `eval` carries one rule beyond its suite — every prompt must have an eval — so it is the only
// step here that can fail with no test file of its own.

// why: Bun ships no synchronous existence check (`Bun.file().exists()` is async, and `isApp` is
// read inside sync object literals) and no path API — `join` builds the path to the config file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import type { TestType } from '@ultimat3/testing';
import { TEST_TYPES } from '@ultimat3/testing';
import { narrowToApp } from './affected-tests';
import { checkEvalBaselines, checkEvalCoverage, checkEvalRecording } from './app-evals';
import { judgeCoverage } from './coverage-floor';
import { withHeavy } from './heavy';
import { msg } from './messages';
import { countsOf } from './test-counts';
import { testEnvOverrides } from './test-dotenv';
import type { TestFile } from './test-select';
import { discoverTests } from './test-select';
import { TEST_TIMINGS_FILE } from './test-shards';
import { machineLease, suiteWeight } from './test-slots';
import type { WorkerPlan } from './test-workers';
import {
  availableCpus,
  fileBoundWidth,
  SERIAL_TYPES,
  totalMemory,
  workerPlan,
} from './test-workers';
import { runCovered } from './verify-coverage-run';
import { judgeE2eBrowser, withE2eApp } from './verify-e2e';
import { factoryFindings } from './verify-factories';
import { readVerifyFloor } from './verify-floor';
import { withTestServices } from './verify-live';
import type { MachinePace } from './verify-pace';
import { paceEnv } from './verify-pace';
import { seedFindings } from './verify-seeds';
import { shardFiles } from './verify-shard';
import type { ChangedTestSelection, StepOutcome, VerifyContext, VerifyStep } from './verify-step';
import { fromExec, fromFindings } from './verify-step';
import { testStepCommand } from './verify-test-command';
import { runParallel } from './verify-test-run';

/**
 * The six types are `@ultimat3/testing`'s declaration, not a list restated here: `unitTest`,
 * `contractTest` and the rest prefix a test's reported name with one of these words, and this
 * package selects a suite by the same word. A copy is one edit away from a step that discovers
 * files no helper produces. `cli -> testing` is a declared sideways edge (`scripts/lib/tiers.ts`)
 * and `@ultimat3/testing` is already a runtime dependency of this package.
 */
export type { TestType } from '@ultimat3/testing';
// Re-exported: every caller that read a test type's filters or argv here still does.
export {
  E2E_PATH_GLOBS,
  E2E_TEST_TIMEOUT_MS,
  ownerOf,
  testStepCommand,
  typeFiltersOf,
} from './verify-test-command';

type TypedTest = Exclude<TestType, 'unit'>;

/**
 * `Object.create(null)`, not a `{}` literal, because `stepFor` reads it with a COMPUTED key
 * (`SUMMARIES[type]`). On a normal object literal every `Object.prototype` member reads back as
 * present, so a table read that way answers a function instead of `undefined` for a key nobody
 * declared — the defect `scripts/proto-index.ts` exists to keep out, thirteen instances across
 * four sweeps. `type` is a closed union here and cannot be `'constructor'` today, which is
 * exactly the argument every one of those thirteen had before it stopped being true.
 *
 * Same repair, and the same reason, as `packages/i18n/src/catalog.ts`. The read itself is guarded
 * too (`summaryOf`), because a construction three screens above a read is not something a static
 * rule should have to reason about.
 */
const SUMMARIES: Readonly<Record<TypedTest, string>> = Object.assign(
  Object.create(null) as Record<TypedTest, string>,
  {
    contract: 'action/query schemas, policy denials, emitted OpenAPI and MCP shapes',
    live: 'live-query snapshots, incremental patches, reconnect deltas',
    job: 'step replay, idempotency dedupe, retry/backoff, outbox atomicity',
    e2e: 'the built output, incl. offline and SW update',
    eval: 'LLM output scored against thresholds',
  },
);

const isSerial = (type: TestType): boolean => SERIAL_TYPES.includes(type);

/**
 * Whether a step applies and what it runs are now one question with one answer: the file list.
 * They used to be two — a glob for `applies`, `--path-ignore-patterns` for the run — and when they
 * drifted, a suite that lived only under an ignored path made its step apply and then fail with
 * "no test files matched", a red gate reporting a suite that by its own rule is not here.
 *
 * Memoized because `runVerify` asks `applies` and then `run`, and a repeated walk of the whole
 * tree per type is the cost this change exists to remove. For one run only: `runVerify` clears it
 * first, since the dev MCP host's `verify` tool runs the gate again in the same process.
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

/** `runVerify` starts every run here; a test that calls a step outside `runVerify` does too. */
export const resetTestDiscovery = (): void => discovered.clear();

/**
 * `files`, when given, is a `--shard` slice: the same one process and the same per-test deadline,
 * over an explicit list instead of the type's own globs — `runParallel` hands `bun test` its files
 * the same way. Serial is a fact about ONE machine (one replication slot, one browser); each CI
 * runner starts its own services, so a slice per runner shares nothing with another runner's.
 */
const runSerial = async (
  ctx: VerifyContext,
  type: TestType,
  files?: readonly string[],
): Promise<StepOutcome> => {
  const whole = testStepCommand(type, ctx.pace);
  const command =
    files === undefined
      ? whole
      : // Its flags kept — the deadline and the ignore list — and its type filters replaced by
        // the slice: `bun test` reads a positional as a path filter either way.
        [...whole.filter((arg, at) => at < 2 || arg.startsWith('--')), ...[...files].sort()];
  const envOverrides = { ...testEnvOverrides(ctx.root, ctx.env ?? Bun.env), ...paceEnv(ctx.pace) };
  // One serial suite is one reservation for its whole length, the app it boots included.
  const execWith =
    (fds: readonly number[]) => (e2e: { command: readonly string[]; env: typeof envOverrides }) =>
      ctx.runner(e2e.command, {
        cwd: ctx.root,
        ...(Object.keys(e2e.env).length === 0 ? {} : { env: e2e.env }),
        ...(fds.length === 0 ? {} : { inheritFds: fds }),
      });
  const hostEnv = ctx.env ?? Bun.env;
  // The e2e step drives a real browser against the app it spawns, when this machine has one.
  const result = await withHeavy(
    { label: `verify ${type}`, cwd: ctx.root, env: hostEnv, ...suiteWeight(type) },
    (child) => {
      const env = { ...envOverrides, ...child.env };
      const exec = execWith(child.fds);
      return type === 'e2e'
        ? withE2eApp({ root: ctx.root, isApp: isApp(ctx.root), command, env, hostEnv }, exec)
        : exec({ command, env });
    },
  );
  const outcome: StepOutcome = {
    ...fromExec(result, {
      code: 'X_TEST_FAILED',
      cause: `one or more ${type} tests failed`,
      fix: command.join(' '),
    }),
    workers: 1,
    tests: countsOf([result]),
  };
  // A floored e2e step that found no browser says which browser to install, never only "re-run".
  return type === 'e2e'
    ? await judgeE2eBrowser({
        root: ctx.root,
        isApp: isApp(ctx.root),
        outcome,
        env: ctx.env ?? Bun.env,
        sharded: ctx.shard !== undefined,
      })
    : outcome;
};

/**
 * `--changed`'s selection, through `x test --affected`'s own rule (`narrowToApp`: a test the module
 * graph never read is KEPT). Never for `eval` (its rules reach past its files) or a suite a doc
 * selected (`whole`): those run every test.
 */
const selectionFor = (ctx: VerifyContext, type: TestType): ChangedTestSelection | undefined =>
  ctx.tests === undefined || type === 'eval' || ctx.tests.whole.includes(type)
    ? undefined
    : ctx.tests;

const runType = async (ctx: VerifyContext, type: TestType): Promise<StepOutcome> => {
  const selected = selectionFor(ctx, type);
  if (isSerial(type) && ctx.shard === undefined && selected === undefined) {
    return runSerial(ctx, type);
  }
  const all = await filesFor(ctx.root, type);
  const discoveredFiles =
    selected === undefined ? all : narrowToApp(all, ctx.root, selected.scope).kept;
  if (selected !== undefined) {
    // No `tests` on the outcome: nothing was spawned, which is not a suite that ran zero tests.
    if (discoveredFiles.length === 0) return { ok: true, findings: [], workers: 0 };
    if (isSerial(type))
      return runSerial(
        ctx,
        type,
        discoveredFiles.map((file) => file.path),
      );
  }
  // Under `--shard`, this job runs its slice and says which — `x verify merge` checks the slices.
  // An EMPTY slice is a pass with zero tests, never the serial fallback below (which would run
  // the whole type): the zero-tests floor is `merge`'s to apply, on the summed counts.
  const shard =
    ctx.shard === undefined
      ? undefined
      : shardFiles(
          discoveredFiles.map((file) => file.path),
          ctx.shard,
          ctx.shard.timings,
        );
  if (shard !== undefined && shard.files.length === 0) {
    return { ok: true, findings: [], workers: 0, tests: { ran: 0, skipped: 0 }, shard };
  }
  if (isSerial(type) && shard !== undefined) {
    return { ...(await runSerial(ctx, type, shard.files)), shard };
  }
  const files =
    shard === undefined
      ? discoveredFiles
      : discoveredFiles.filter((file) => shard.files.includes(file.path));
  if (files.length === 0) return runSerial(ctx, type);
  const env = ctx.env ?? Bun.env;
  const plan =
    ctx.workers === undefined ? workerPlan(availableCpus(), totalMemory(), env) : undefined;
  const workers = ctx.workers ?? (plan as WorkerPlan).workers;
  const lease = machineLease(env, {
    cwd: ctx.root,
    label: `verify ${type}`,
    type,
    ...(plan === undefined ? { exact: true } : {}),
  });
  const widthReason =
    plan === undefined
      ? `${String(Math.min(workers, files.length))} workers (--workers)`
      : files.length < plan.workers
        ? fileBoundWidth(files.length, plan.reason)
        : plan.reason;
  // A subset cannot hold the whole tree's coverage floor: only a full unit run is judged.
  if (type === 'unit' && isApp(ctx.root) && selected === undefined) {
    return coveredUnit(ctx, {
      files: files.map((file) => file.path),
      workers,
      widthReason,
      shard,
      lease,
      pace: ctx.pace,
    });
  }
  const outcome = await runParallel({
    root: ctx.root,
    runner: ctx.runner,
    files,
    workers,
    type,
    isolate: ctx.isolate === true,
    widthReason,
    ...(lease === undefined ? {} : { lease }),
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
    ...(ctx.pace === undefined ? {} : { pace: ctx.pace }),
  });
  return shard === undefined ? outcome : { ...outcome, shard };
};

/**
 * An APP's unit step: the suite, and what it covered of the app's own source held to the floor in
 * `x.verify.json` (`coverage-floor.ts`). Only the unit suite counts — it is the one every run
 * executes, and an opt-in suite cannot hold a floor a default run must meet. Only an app: the
 * framework's packages are held to the same bar one process each, by `scripts/coverage-gate.ts`,
 * because one run over a monorepo reads every package diluted by the ones it imports.
 *
 * A red suite is not judged — a slice that died wrote no lcov, and a coverage finding beside
 * `X_TEST_FAILED` would send the reader to the wrong fix. A `--shard` slice is not judged either:
 * it hands its facts to `x verify merge`, which folds every shard and judges once.
 */
const coveredUnit = async (
  ctx: VerifyContext,
  run: {
    readonly files: readonly string[];
    readonly workers: number;
    readonly widthReason: string;
    readonly shard: ReturnType<typeof shardFiles> | undefined;
    readonly lease: ReturnType<typeof machineLease> | undefined;
    readonly pace: MachinePace | undefined;
  },
): Promise<StepOutcome> => {
  const { coverage, ...outcome } = await runCovered({
    root: ctx.root,
    runner: ctx.runner,
    files: run.files,
    workers: run.workers,
    isolate: ctx.isolate === true,
    widthReason: run.widthReason,
    ...(run.lease === undefined ? {} : { lease: run.lease }),
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
    ...(run.pace === undefined ? {} : { pace: run.pace }),
    // Orders the slices longest-first and learns this run's per-file durations (`test-timings.ts`).
    timings: join(ctx.root, TEST_TIMINGS_FILE),
  });
  if (!outcome.ok) return run.shard === undefined ? outcome : { ...outcome, shard: run.shard };
  if (run.shard !== undefined) {
    return {
      ...outcome,
      shard: run.shard,
      coverage,
      output: msg('cli.verify.coverageDeferred'),
    };
  }
  const verdict = await judgeCoverage(
    ctx.root,
    coverage,
    (await readVerifyFloor(ctx.root))?.coverage,
  );
  return {
    ...outcome,
    ok: verdict.findings.length === 0,
    findings: verdict.findings,
    output: verdict.output,
    measured: {
      lines: verdict.measure.lines,
      funcs: verdict.measure.funcs,
      files: verdict.measure.files,
    },
  };
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
  summary: SUMMARIES.eval,
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

/**
 * The one computed read of `SUMMARIES`, guarded. The table is already prototype-free
 * (`Object.create(null)`), which is what makes the READ safe — and `scripts/proto-index.ts`
 * recognises a guard on the read itself, not a construction three screens above it. So the guard
 * is here: a rule that has to reason about how a table was built is one tightening away from
 * reporting this line, and a pin is a rule with a hole in it.
 */
const summaryOf = (type: TypedTest): string =>
  Object.hasOwn(SUMMARIES, type) ? SUMMARIES[type] : `${type} tests`;

/**
 * The unit suite, and beside it an app's factory lint (`verify-factories.ts`) and seed run
 * (`verify-seeds.ts`): a factory or a seed row its entity refuses is found here, with the entity's
 * own code, not by every test that uses it or inside e2e's X_E2E_APP_FAILED. The two are separate
 * children run at once, so the step pays the slower one. Under `--shard` only slice 1 runs them,
 * so `x verify merge` reports each finding once.
 */
const unitStep = async (ctx: VerifyContext): Promise<StepOutcome> => {
  const suite = await runType(ctx, 'unit');
  if (!isApp(ctx.root) || (ctx.shard !== undefined && ctx.shard.index !== 1)) return suite;
  const [factories, seeds] = await Promise.all([
    factoryFindings(ctx.root, ctx.runner),
    seedFindings(ctx.root, ctx.runner),
  ]);
  if (factories.length === 0 && seeds.length === 0) return suite;
  return { ...suite, ok: false, findings: [...factories, ...seeds, ...suite.findings] };
};

const stepFor = (type: TestType): VerifyStep => {
  if (type === 'unit') {
    return {
      name: 'unit',
      summary: 'pure logic — no database, no network',
      run: unitStep,
    };
  }
  if (type === 'eval') return evalStep;
  return {
    name: type,
    summary: summaryOf(type),
    applies: async (ctx) => (await filesFor(ctx.root, type)).length > 0,
    run: (ctx) => runType(ctx, type),
  };
};

/** One test type's step BEFORE the live wrap: what `verify-live.test.ts` wraps over its own probe. */
export const bareTestStep = stepFor;

/** In cost order: unit needs nothing, e2e needs a build. */
// The live step brings up the app's own test database when none answers (`verify-live.ts`).
export const TEST_STEPS: readonly VerifyStep[] = TEST_TYPES.map(stepFor).map((step) =>
  step.name === 'live' ? withTestServices(step) : step,
);
