// What decides a test file's type, and the `bun test` argv each type's step runs: the ordered
// ownership rules, the ignore globs, the per-type filters and timeouts. Split from `verify-tests.ts`
// at its 500-line ceiling, which builds the steps; one definition here, so `x test <type>` and the
// gate's `<type>` step can never disagree about what a suite is.

import type { TestType } from '@ultimat3/testing';
import { IGNORED_TEST_PATTERNS } from './test-ignores';
import type { MachinePace } from './verify-pace';
import { DECLARED_PACE, defaultTimeoutArgs, pacedMs } from './verify-pace';

type TypedTest = Exclude<TestType, 'unit'>;

const TYPED_SUFFIXES = '{contract,live,job,e2e,eval}';

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
 * Build output, and nested projects that carry their own `x verify`. `examples/**` and
 * `dummy/**` are the second kind: each holds a whole app gated by its own run of this same step
 * list, so collecting them here would report one app failure on two different gates. The patterns
 * are relative to the run's root, so this excludes nothing when the app itself is the root. The
 * policy — which directories, and which are anchored at the root — is `test-ignores.ts`'s, the same
 * one `discoverTests` filters the parallel steps by; this is its glob projection.
 *
 * `dummy/**` was added after the framework gate started running a demo app's tests and disagreeing
 * with `bun run test` — which already excluded it — for no reason a reader could see.
 *
 * Excluded here is not ungated: `scripts/reference-app-gate.ts` runs `x verify` inside each of
 * those apps and blocks on a per-app ratchet. Until 2026-08 that was only true of `examples/**`,
 * and `dummy/social-media-clone` was excluded by this list and gated by nothing.
 */
const NEVER_A_TEST = IGNORED_TEST_PATTERNS;

const ignoreFlags = (patterns: readonly string[]): readonly string[] =>
  patterns.map((pattern) => `--path-ignore-patterns=${pattern}`);

/**
 * The substrings that decide a file's type — the same ones the step's `bun test` runs with, so
 * `x test <type>` and the gate's `<type>` step can never disagree about what a contract test is.
 */
export const typeFiltersOf = (type: Exclude<TestType, 'unit'>): readonly string[] =>
  OWNERSHIP.filter(([owner]) => owner === type).map(([, filter]) => filter);

/**
 * What an e2e test's path is, as globs: the e2e step's own substrings (`typeFiltersOf('e2e')`),
 * each spelt as the glob matching the same paths. One definition, read three ways — the e2e step
 * selects by the substrings, the unit step ignores these globs, and `scripts/coverage-gate.ts`
 * leaves them out of a package's coverage: an e2e suite drives a built app through a browser and
 * child processes no in-process lcov sees, and it already runs in its own gate step.
 */
export const E2E_PATH_GLOBS: readonly string[] = typeFiltersOf('e2e').map((filter) =>
  filter.endsWith('/') ? `**/*${filter}**` : `**/*${filter}*`,
);

/**
 * An e2e test's own budget: a first navigation waits on `x dev` compiling the route and its island,
 * which bun's default 5 s does not cover — a timeout there reads as an app bug that is not one.
 */
export const E2E_TEST_TIMEOUT_MS = 60_000;

/**
 * Unit is everything the typed suites do not claim, so no test can fall between two steps. Each
 * per-test default is read at the machine's `pace` (`verify-pace.ts`).
 */
export const testStepCommand = (type: TestType, pace?: MachinePace): readonly string[] =>
  type === 'unit'
    ? [
        'bun',
        'test',
        ...defaultTimeoutArgs(pace),
        ...ignoreFlags([...NEVER_A_TEST, ...E2E_PATH_GLOBS, `**/*.${TYPED_SUFFIXES}.test.*`]),
      ]
    : [
        'bun',
        'test',
        ...(type === 'e2e'
          ? [`--timeout=${String(pacedMs(E2E_TEST_TIMEOUT_MS, pace ?? DECLARED_PACE))}`]
          : defaultTimeoutArgs(pace)),
        ...ignoreFlags([...NEVER_A_TEST, ...disownedBy(type)]),
        ...typeFiltersOf(type),
      ];
