// One gate step per test type, so every type reports on its own line. A test's type is its
// filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`, `*.e2e.test.ts`,
// `*.eval.test.ts` — and only then the `e2e/` directory it sits in, which is why `OWNERSHIP` below
// is an ordered list. Everything else is a unit test, the only step that selects by exclusion.
//
// `eval` carries one rule beyond its suite — every prompt must have an eval — so it is the only
// step here that can fail with no test file of its own.

// Bun ships no `Bun.*` equivalent for either: `existsSync` answers whether this root is an app,
// and `join` builds the host-separator path to its config file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestType } from '@ultimat3/testing';
import { TEST_TYPES } from '@ultimat3/testing';
import { checkEvalBaselines, checkEvalCoverage, checkEvalRecording } from './app-evals';
import { APP_CONFIG_FILE } from './app-root';
import { countsOf } from './test-counts';
import type { TestFile } from './test-select';
import { discoverTests } from './test-select';
import { defaultWorkers } from './test-workers';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';
import { fromExec, fromFindings } from './verify-step';
import { runParallel } from './verify-test-run';

/**
 * The six types are `@ultimat3/testing`'s declaration, not a list restated here: `unitTest`,
 * `contractTest` and the rest prefix a test's reported name with one of these words, and this
 * package selects a suite by the same word. A copy is one edit away from a step that discovers
 * files no helper produces. `cli -> testing` is a declared sideways edge (`scripts/lib/tiers.ts`)
 * and `@ultimat3/testing` is already a runtime dependency of this package.
 */
export type { TestType } from '@ultimat3/testing';
export { TEST_TYPES } from '@ultimat3/testing';

type TypedTest = Exclude<TestType, 'unit'>;

const TYPED_SUFFIXES = '{contract,live,job,e2e,eval}';

const SUMMARIES: Readonly<Record<TypedTest, string>> = {
  contract: 'action/query schemas, policy denials, emitted OpenAPI and MCP shapes',
  live: 'live-query snapshots, incremental patches, reconnect deltas',
  job: 'step replay, idempotency dedupe, retry/backoff, outbox atomicity',
  e2e: 'the built output, incl. offline and SW update',
  eval: 'LLM output scored against thresholds',
};

/**
 * Every rule that decides a file's type, MOST SPECIFIC FIRST: the first entry a path matches owns
 * it, and no later entry may claim it. Each is a substring `bun test` matches against a file path,
 * which is exactly how bun reads more than one positional filter (measured: `.contract.test.` +
 * `.job.test.` runs the union of both suites, never the intersection).
 *
 * A FILENAME declares a type; a DIRECTORY only fills in for a filename that declares none — which
 * is why the one directory rule is last. Ownership had no order at all until 2026-08, so
 * `packages/app/e2e/payment.contract.test.ts` matched `.contract.test.` AND `e2e/`: the `contract`
 * step selected it by name while the `e2e` step's argv selected it by directory, and one test ran
 * twice in one gate. The bare word `e2e` was worse still — it matched any path holding those three
 * characters anywhere, so `src/e2e-helpers.test.ts` joined the e2e step and left the unit step,
 * which selects by exclusion.
 */
const OWNERSHIP = [
  ['contract', '.contract.test.'],
  ['live', '.live.test.'],
  ['job', '.job.test.'],
  ['e2e', '.e2e.test.'],
  ['eval', '.eval.test.'],
  // `e2e/`, not `/e2e/`: bun matches a filter against the cwd-relative path and answers
  // `Test filter "/e2e/" had no matches` for the anchored form (bun 1.3.14). The trailing slash
  // is the boundary this can express, and it is the same string `ownerOf` ranks last, so the
  // step's argv and the file list can never disagree about what an e2e test is.
  ['e2e', 'e2e/'],
] as const satisfies readonly (readonly [TypedTest, string])[];

/** The types whose filename rule outranks the `e2e/` directory — e2e's own never does. */
const OUTRANKING_E2E: readonly TypedTest[] = [
  ...new Set(OWNERSHIP.filter(([type]) => type !== 'e2e').map(([type]) => type)),
];

/**
 * The one suite a path belongs to, and `unit` when no rule claims it — the single definition of a
 * file's type, which both `x test <type>` and the gate's own steps select through. Exactly one
 * owner is the point: two owners is a file two steps run, and a test that runs twice in one gate
 * proves nothing the first run did not.
 */
export const ownerOf = (path: string): TestType =>
  OWNERSHIP.find(([, filter]) => path.includes(filter))?.[0] ?? 'unit';

/**
 * Paths a suite's own filters match but the suite does NOT own, as `--path-ignore-patterns`. Only
 * `e2e` has any, for the reason above. It has to be said in the argv and not only in `ownerOf`:
 * bun has no "match this and not that" filter, and a serial step runs the argv rather than a file
 * list — so exclusivity that lived only in the file list would still have run the file twice.
 */
const disownedBy = (type: TypedTest): readonly string[] =>
  type === 'e2e' ? [`**/e2e/**/*.{${OUTRANKING_E2E.join(',')}}.test.*`] : [];

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
  OWNERSHIP.filter(([owner]) => owner === type).map(([, filter]) => filter);

/** Unit is everything the typed suites do not claim, so no test can fall between two steps. */
export const testStepCommand = (type: TestType): readonly string[] =>
  type === 'unit'
    ? [
        'bun',
        'test',
        ...ignoreFlags([...NEVER_A_TEST, '**/e2e/**', `**/*.${TYPED_SUFFIXES}.test.*`]),
      ]
    : [
        'bun',
        'test',
        ...ignoreFlags([...NEVER_A_TEST, ...disownedBy(type)]),
        ...typeFiltersOf(type),
      ];

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
    summary: SUMMARIES[type],
    applies: async (ctx) => (await filesFor(ctx.root, type)).length > 0,
    run: (ctx) => runType(ctx, type),
  };
};

/** In cost order: unit needs nothing, e2e needs a build. */
export const TEST_STEPS: readonly VerifyStep[] = TEST_TYPES.map(stepFor);
