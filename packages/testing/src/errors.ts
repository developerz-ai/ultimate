// The X_* codes owned by @ultimat3/testing. A test failure has to be as actionable as a runtime
// failure — the fix line here is the mock to add, the service to start, or the seed to freeze.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

// `X_TEST_REGISTRY_LEAK` is declared below, in this registry; its message lives beside it.
export { RegistryLeakError } from './registry-leak-error';

export const TESTING_ERROR_CODES = [
  'X_TEST_NETWORK_SEALED',
  'X_TEST_NETWORK_OFFLINE',
  'X_TEST_DB_UNAVAILABLE',
  'X_TEST_NONDETERMINISTIC',
  'X_TEST_FIXTURE_UNKNOWN',
  'X_TEST_FIXTURE_UNAVAILABLE',
  'X_TEST_EVAL_THRESHOLD',
  'X_TEST_SCHEMA_EXPECTED',
  'X_TEST_JOB_EXPECTED',
  'X_TEST_LOCATOR_EXPECTED',
  'X_TEST_NETWORK_RACE',
  'X_TEST_FACTORY_TRAIT_UNKNOWN',
  'X_TEST_FACTORY_NOT_PERSISTED',
  'X_TEST_REGISTRY_LEAK',
  'X_TEST_LIVE_NODE_EMPTY',
  'X_TEST_LIVE_NODE_UPGRADE_REFUSED',
  'X_TEST_ISLAND_NOT_BUILT',
  'X_TEST_ISLAND_NO_MOUNT',
  // Declared here and thrown from `island-selector.ts`, for the reason the states codes below are.
  'X_TEST_ISLAND_SELECTOR_UNSUPPORTED',
  // Declared here and thrown from `island-state-errors.ts`: one file has one job and this
  // catalogue is at its ceiling, so the classes moved and the registration did not.
  'X_TEST_ISLAND_STATES_EMPTY',
  'X_TEST_ISLAND_STATES_NOT_PURE',
  'X_TEST_ISLAND_STATES_MISSING_FILE',
  'X_TEST_ISLAND_STATES_UNKNOWN',
  'X_TEST_ISLAND_STATES_AMBIGUOUS',
  'X_TEST_ISLAND_STATE_ID_INVALID',
  'X_TEST_ISLAND_STATE_DUPLICATE',
  'X_TEST_ISLAND_STATE_JSON_INVALID',
  'X_TEST_ISLAND_STATE_CLOCK_INVALID',
  'X_TEST_ISLAND_STATE_STUB_INVALID',
  'X_TEST_POLICY_EXPECTED',
  'X_TEST_OPENAPI_EXPECTED',
  'X_TEST_NUMBER_EXPECTED',
  'X_TEST_ISLAND_STATE_UNKNOWN',
  'X_TEST_APP_NOT_BOOTED',
  'X_TEST_PACE_INVALID',
  'X_SEED_GRAPH_UNSATISFIED',
  'X_E2E_A11Y_VIOLATION',
  'X_SEED_GRAPH_ENTITY_UNKNOWN',
  'X_TENANT_LEAK',
  'X_TENANT_WRITE_CROSSED',
  'X_JOB_CRASH_DIVERGED',
  'X_JOB_SIM_INVARIANT',
  'X_JOB_SIM_NONDETERMINISTIC',
  'X_DRILL_FAILED',
  'X_DRILL_SERVICE_MISSING',
  'X_SUBJECT_ERASE_INCOMPLETE',
  'X_QUERY_UNINDEXED',
  'X_QUERY_SORT_UNSERVED',
  'X_QUERY_SCALES_WITH_ROWS',
  'X_QUERY_PLAN_UNAVAILABLE',
  'X_CASSETTE_MISSING',
  'X_CASSETTE_UNUSED',
  'X_CASSETTE_SECRET',
  'X_CASSETTE_RECORD_REFUSED',
  'X_TEST_MODULE_MOCK_UNRESTORABLE',
  'X_EXERCISE_SETUP_UNSEALED',
  'X_JOB_CRASH_UNBOUNDED',
  'X_EXERCISE_ACTOR_USER_UNSEATED',
  'X_EXERCISE_INPUT_THREW',
  'X_TEST_SCOPE_UNINSTALLED',
  'X_TEST_STUB_UNANSWERED',
  'X_TEST_STUB_TARGET_UNSUPPORTED',
  'X_TEST_EXPECTED_INPUT_INVALID',
  'X_TEST_RUN_JOBS_EXPECTED',
  'X_TEST_MAIL_EXPECTED',
  'X_TEST_ADAPTER_PORT_UNSWAPPABLE',
  'X_TEST_FACTORY_INVALID',
  'X_EXERCISE_SEED_FAILED',
  'X_STATEMENTS_OVER_BUDGET',
  'X_EXERCISE_EMPTY_REACH',
] as const;

export type TestingErrorCode = (typeof TESTING_ERROR_CODES)[number];

export const TESTING_ERROR_TITLES: Readonly<Record<TestingErrorCode, string>> = {
  X_TEST_NETWORK_SEALED: 'a test tried to reach the network',
  X_TEST_NETWORK_OFFLINE: 'the test network is offline',
  X_TEST_DB_UNAVAILABLE: 'no Postgres for the test template',
  X_TEST_NONDETERMINISTIC: 'a test read wall-clock time or unseeded randomness',
  X_TEST_FIXTURE_UNKNOWN: 'a test requested a fixture nobody registered',
  X_TEST_FIXTURE_UNAVAILABLE: 'a declared fixture has no driver in this process',
  X_TEST_EVAL_THRESHOLD: 'an evalTest() score fell below its threshold',
  X_TEST_SCHEMA_EXPECTED: 'a matcher expected a Standard Schema and got something else',
  X_TEST_JOB_EXPECTED: 'a matcher expected a job declaration and got something else',
  X_TEST_LOCATOR_EXPECTED: 'a matcher expected a locator and got something else',
  X_TEST_NETWORK_RACE: 'a request raced unsealNetwork() and lost the patched fetch',
  X_TEST_FACTORY_TRAIT_UNKNOWN: 'a factory was asked for a trait it does not declare',
  X_TEST_FACTORY_NOT_PERSISTED: 'a factory create() had nowhere to write the row',
  X_TEST_REGISTRY_LEAK: 'a test file left a process-global registry dirty',
  X_TEST_LIVE_NODE_EMPTY: 'the in-process sync node has no live query to serve',
  X_TEST_LIVE_NODE_UPGRADE_REFUSED: 'the in-process sync node refused the connection',
  X_TEST_ISLAND_NOT_BUILT: 'the island build produced no chunk for the file the test named',
  X_TEST_ISLAND_NO_MOUNT: 'an island chunk exports no mount function',
  X_TEST_ISLAND_SELECTOR_UNSUPPORTED: "a selector is outside the island DOM's grammar",
  X_TEST_ISLAND_STATES_EMPTY: 'an island state manifest declares no states',
  X_TEST_ISLAND_STATES_NOT_PURE:
    'an island states file imports the component, a renderer or a sibling module',
  X_TEST_ISLAND_STATES_MISSING_FILE: 'an island state manifest names an island that is not on disk',
  X_TEST_ISLAND_STATES_UNKNOWN: 'no island state manifest answers to that name',
  X_TEST_ISLAND_STATES_AMBIGUOUS: 'two island state manifests answer to one name',
  X_TEST_ISLAND_STATE_ID_INVALID: 'an island state id is not slug-shaped',
  X_TEST_ISLAND_STATE_DUPLICATE: 'two island states share one id',
  X_TEST_ISLAND_STATE_JSON_INVALID: 'an island state carries a value JSON does not',
  X_TEST_ISLAND_STATE_CLOCK_INVALID: 'an island state manifest pins a clock that is not pinnable',
  X_TEST_ISLAND_STATE_STUB_INVALID: 'an island route stub is not "<METHOD> <pathname>"',
  X_TEST_POLICY_EXPECTED: 'a matcher expected a policy and got something else',
  X_TEST_OPENAPI_EXPECTED: 'a matcher expected an OpenAPI document and got something else',
  X_TEST_NUMBER_EXPECTED: 'a matcher expected a finite number and got something else',
  X_TEST_ISLAND_STATE_UNKNOWN: 'an island state manifest declares no state with that id',
  X_TEST_APP_NOT_BOOTED: 'describeApp handle read before boot',
  X_TEST_PACE_INVALID: 'ULTIMATE_TEST_PACE is not a number at or above 1',
  X_SEED_GRAPH_UNSATISFIED: 'no generated row satisfies a table',
  X_E2E_A11Y_VIOLATION: 'a page fails the accessibility audit',
  X_SEED_GRAPH_ENTITY_UNKNOWN: 'a seed plan names an entity its writer was not given',
  X_TENANT_LEAK: "another tenant's row reached a call's output or effect",
  X_TENANT_WRITE_CROSSED: "a call by one tenant changed another tenant's row",
  X_JOB_CRASH_DIVERGED:
    'a job run killed at a step boundary made an effect a different number of times than a clean run',
  X_JOB_SIM_INVARIANT: 'a simulateJobs seed broke the invariant the test stated',
  X_JOB_SIM_NONDETERMINISTIC: 'one simulateJobs seed produced two different traces',
  X_DRILL_FAILED: 'a fault drill property did not hold',
  X_DRILL_SERVICE_MISSING: 'a fault drill needs a service that is not there',
  X_SUBJECT_ERASE_INCOMPLETE: 'a value of the subject survived subjectErase',
  X_QUERY_UNINDEXED: 'a statement no index can serve: the planner can only scan the table',
  X_QUERY_SORT_UNSERVED: 'a limited read sorts its rows: no index serves the order',
  X_QUERY_SCALES_WITH_ROWS:
    'a statement shape runs once per row: its count grows with the rows seeded',
  X_QUERY_PLAN_UNAVAILABLE:
    'the database could not answer a generic plan, so no statement was judged',
  X_CASSETTE_MISSING: 'a cassette replayed with no recording on disk',
  X_CASSETTE_UNUSED: 'a cassette entry was never replayed',
  X_CASSETTE_SECRET: 'a cassette about to be written holds a secret value',
  X_CASSETTE_RECORD_REFUSED: 'a cassette recording was refused',
  X_TEST_MODULE_MOCK_UNRESTORABLE: 'a mocked module could not be put back at the file boundary',
  X_EXERCISE_SETUP_UNSEALED: 'an exercise setup let a host through the seal',
  X_JOB_CRASH_UNBOUNDED: 'a crash proof needs more kill points than its bound',
  X_EXERCISE_ACTOR_USER_UNSEATED: "the exercise pass could not seat its actor's x_users row",
  X_EXERCISE_INPUT_THREW: "an exercise entry's input threw",
  X_TEST_SCOPE_UNINSTALLED:
    'a test double was made in a process the testing preload did not set up',
  X_TEST_STUB_UNANSWERED: 'a stubbed primitive was called before any answer was scripted',
  X_TEST_STUB_TARGET_UNSUPPORTED:
    'stub() was handed something that is not an action, llm(), query or job',
  X_TEST_EXPECTED_INPUT_INVALID: "an assertion named an input its primitive's schema rejects",
  X_TEST_RUN_JOBS_EXPECTED: 'toHaveEnqueued was handed something other than the runJobs fixture',
  X_TEST_MAIL_EXPECTED: 'toHaveSentMail was handed something other than the mail fixture',
  X_TEST_ADAPTER_PORT_UNSWAPPABLE: 'swapAdapter() was named a port it cannot swap for one test',
  X_TEST_FACTORY_INVALID: 'a factory builds a row its own entity refuses',
  X_EXERCISE_SEED_FAILED: 'The scale sweep could not write the sized rows of one entity',
  X_STATEMENTS_OVER_BUDGET: 'One primitive call sent more statements than its ceiling',
  X_EXERCISE_EMPTY_REACH:
    'an exercised primitive was reached and sent no statement and had no effect',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(TESTING_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

// No `docs:` below: `UltimateError` fills core's `ERROR_DOCS_URL`, one page per code set (a wiki
// TABLE ROW has no anchor; per-code links answered 404 until 9.x). Restating it here would drift.

/** Which dial refused, and so which repair: `dns-record` is a query no mock answers (an MX, a TXT,
 *  a reverse lookup), so its fix opens with the one line that lifts it. */
export type SealedTransport = 'fetch' | 'socket' | 'dns' | 'dns-record';

const sealedFix = (url: string, transport: SealedTransport): string => {
  const host = hostOf(url);
  const allow = `allowHost('${host}') if it must be real`;
  switch (transport) {
    case 'socket':
      return `allowHost('${host}')   # only if it must be real — otherwise inject the transport: pass the code under test its \`connect\`/\`client\` option, or dial a Bun.listen server on 127.0.0.1 (loopback is never sealed)`;
    case 'dns':
      return `mockFetch('https://${host}/*', () => new Response('{}'))   # a mocked host resolves — or ${allow}`;
    case 'dns-record':
      return `allowHost('${host}')   # only if it must be real — a mockFetch route answers an address lookup, never this record or a reverse lookup: inject the resolver into the code under test otherwise`;
    case 'fetch':
      return `mockFetch('${url}', () => new Response('{}')) — or ${allow}`;
  }
};

/**
 * A test reached the network without a mock or an allowlist entry. Always a bug, never a flake.
 * `transport` picks the repair: a `fetch` is mocked, a socket (`WebSocket`, `Bun.connect`) has no
 * mock — the code under test takes its transport as a parameter, and the test hands one in.
 */
export class NetworkSealedError extends UltimateError {
  constructor(input: {
    url: string;
    method: string;
    allowed: readonly string[];
    transport?: SealedTransport | undefined;
  }) {
    super({
      code: 'X_TEST_NETWORK_SEALED',
      cause: `${input.method} ${input.url} was not mocked (allowed hosts: ${
        input.allowed.length > 0 ? input.allowed.join(', ') : 'none'
      })`,
      fix: sealedFix(input.url, input.transport ?? 'fetch'),
    });
  }
}

/** No Postgres and no PGlite: the harness cannot give the test a database to clone. */
export class TestDatabaseUnavailableError extends UltimateError {
  constructor(input: { cause: string }) {
    super({
      code: 'X_TEST_DB_UNAVAILABLE',
      cause: input.cause,
      fix: 'x dev (embedded Postgres), or set TEST_DATABASE_URL to a running Postgres',
    });
  }
}

/** Two runs of the same test produced different values. The seed or the clock is not frozen. */
export class NondeterministicError extends UltimateError {
  constructor(input: { what: string; first: string; second: string }) {
    super({
      code: 'X_TEST_NONDETERMINISTIC',
      cause: `${input.what} produced "${input.first}" then "${input.second}"`,
      fix: "assertDeterministic('…', () => { installDeterminism(); return body(); })",
    });
  }
}

/** `describeApp`'s `app()` read while the block was still being registered, before `beforeAll`. */
export class AppNotBootedError extends UltimateError {
  constructor(input: { suite: string }) {
    super({
      code: 'X_TEST_APP_NOT_BOOTED',
      cause: `describeApp('${input.suite}') — app() was called while the describe block was being registered, before its beforeAll booted the app`,
      fix: "test('…', () => { const handle = app(); })",
    });
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A test destructured a fixture nobody registered. Naming the registered set matters: the
 * failure would otherwise surface as `undefined is not an object` deep inside the body,
 * pointing at the use rather than the missing registration.
 */
export class FixtureUnknownError extends UltimateError {
  constructor(input: { name: string; registered: readonly string[] }) {
    super({
      code: 'X_TEST_FIXTURE_UNKNOWN',
      cause:
        input.registered.length === 0
          ? `test requested fixture "${input.name}" but none are registered`
          : `test requested fixture "${input.name}"; registered: ${input.registered.join(', ')}`,
      fix: `register it at test setup: defineFixtures({ ${input.name}: () => buildIt() })`,
    });
  }
}

export const fixtureUnknown = (name: string, registered: readonly string[]): UltimateError =>
  new FixtureUnknownError({ name, registered });

/**
 * Different failure from `X_TEST_FIXTURE_UNKNOWN`, and the distinction is the whole point: the
 * name IS registered, so "register it" is the wrong instruction. What is missing is the driver
 * underneath — a browser, a replicator — which the framework declares but deliberately does not
 * bundle. Naming what it needs turns "undefined is not an object" into a decision the reader can
 * make: install the driver, or stop asking for the fixture.
 */
export class FixtureUnavailableError extends UltimateError {
  constructor(input: { name: string; needs: string }) {
    super({
      code: 'X_TEST_FIXTURE_UNAVAILABLE',
      cause: `fixture "${input.name}" is declared but nothing in this process drives it — it needs ${input.needs}`,
      fix: `install one in the test preload: defineFixtures({ ${input.name}: () => yourDriver() })`,
    });
  }
}

export const fixtureUnavailable = (name: string, needs: string): UltimateError =>
  new FixtureUnavailableError({ name, needs });

/**
 * The `subscribe` fixture built a node and found nothing to register. A registry with no definition
 * answers every subscribe with "no live query registered" — a working socket serving no reads,
 * which looks the same as a harness that is broken and an app that declared nothing. Said at the
 * one moment the count is known, rather than three awaits later at the first subscribe.
 *
 * Almost always the same cause: the app's api module was never imported, so `registerQueries()`
 * never ran and `listQueries()` is empty. The preload is where an app imports it — see
 * `examples/dummy/scripts/test-setup.ts`.
 */
export class LiveNodeEmptyError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_LIVE_NODE_EMPTY',
      cause:
        'no query declared live: true is registered in this process, so the node would serve none',
      fix: "import the app's api module in the test preload — import './apps/web/api' — then: x queries list --json",
    });
  }
}

export const liveNodeUnavailable = (): UltimateError => new LiveNodeEmptyError();

/**
 * The node answered the upgrade with a response instead of taking it. A REAL refusal — the accept
 * budget, the connection ceiling, or a node that is not ready — and a different failure from
 * "nothing to serve", which is what this path reported until 2026-08-20 and sent a reader looking
 * for a missing query rather than at a node that never started.
 */
export class LiveNodeUpgradeRefusedError extends UltimateError {
  constructor(status: number | undefined) {
    super({
      code: 'X_TEST_LIVE_NODE_UPGRADE_REFUSED',
      cause: `the sync node answered the upgrade with ${status === undefined ? 'no response' : `HTTP ${String(status)}`} instead of taking it`,
      fix: 'await node.start() before connect(), and keep the request path at /_x/sync',
    });
  }
}

export const upgradeRefused = (status: number | undefined): UltimateError =>
  new LiveNodeUpgradeRefusedError(status);

/**
 * A request made while `network.offline()` (or `network.drop()`) is in force. Coded rather than a
 * bare `TypeError` because a test that lands here uncaught needs to know which of the two it was:
 * the app's offline path not running, or a fixture left offline by the test before it.
 */
export class NetworkOfflineError extends UltimateError {
  constructor(input: { url: string; method: string; mode: 'offline' | 'dropped' }) {
    super({
      code: 'X_TEST_NETWORK_OFFLINE',
      cause: `${input.method} ${input.url} while the test network is ${input.mode}`,
      fix: 'network.online() before the call — or assert the offline path instead of the request',
    });
  }
}

/** `evalTest()`'s score fell below its declared threshold. A test failure, not a warning. */
export class TestEvalThresholdError extends UltimateError {
  constructor(input: { name: string; threshold: number; detail: string }) {
    super({
      code: 'X_TEST_EVAL_THRESHOLD',
      cause: `eval "${input.name}" scored below ${input.threshold}: ${input.detail}`,
      fix: 'improve the prompt under test, or lower the threshold passed to evalTest()',
    });
  }
}

/** `toRejectInput`/`toAcceptInput` were handed something other than a Standard Schema. */
export class TestSchemaExpectedError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_SCHEMA_EXPECTED',
      cause: 'toRejectInput/toAcceptInput expect a Standard Schema (`t`), not the action',
      // Names the call, not the intent: "assert against action.input" left the reader to work out
      // which call to edit, and a fix is only executable if it can be pasted over the failing line.
      fix: 'call toRejectInput(action.input) — the schema, not toRejectInput(action) or the query',
    });
  }
}

/**
 * `toBeVisible` was handed something with no `isVisible()` — a page, a selector string, or the
 * result of awaiting the locator. Thrown rather than returned as a failing result, exactly as
 * `TestSchemaExpectedError` is: the assertion is not false, it is unanswerable, and a `pass: false`
 * would read as "the element was hidden".
 */
export class TestLocatorExpectedError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_LOCATOR_EXPECTED',
      cause: 'toBeVisible expects a locator — an object with isVisible() — not a page or a string',
      fix: 'expect(page.getByRole("heading", { name: "Feed" })).toBeVisible()   # the locator itself, unawaited',
    });
  }
}

/** `toEmitSteps`/`recordSteps` were handed something other than a job declaration. */
export class TestJobExpectedError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_JOB_EXPECTED',
      cause: 'toEmitSteps expects a job declaration built with job(...)',
      // Same rule as X_TEST_SCHEMA_EXPECTED's: the paste-able call, not a description of it.
      fix: 'call toEmitSteps(myJob) with the job export, not toEmitSteps(myJob.run)',
    });
  }
}

/**
 * A factory was asked for a trait it does not declare. Listing the declared ones is the whole
 * value: a typo (`:pubished`) and a trait that was never written are the same symptom and
 * different fixes, and only the list tells them apart without opening the factory.
 */
export class FactoryTraitUnknownError extends UltimateError {
  constructor(input: { table: string; trait: string; declared: readonly string[] }) {
    super({
      code: 'X_TEST_FACTORY_TRAIT_UNKNOWN',
      cause:
        input.declared.length === 0
          ? `factory "${input.table}" was asked for trait "${input.trait}" but declares none`
          : `factory "${input.table}" has no trait "${input.trait}"; declared: ${input.declared.join(', ')}`,
      fix: `declare it: defineFactory(${input.table}, { traits: { ${input.trait}: { /* columns */ } } })`,
    });
  }
}

/**
 * `create()` with no persister installed. Distinct from "the insert failed": nothing was attempted,
 * so the instruction is to install the seam once in the preload — or to stop asking for a row that
 * outlives the test, which `build()` already gives without a database at all.
 */
export class FactoryNotPersistedError extends UltimateError {
  constructor(input: { table: string }) {
    super({
      code: 'X_TEST_FACTORY_NOT_PERSISTED',
      cause: `factory "${input.table}".create() has nowhere to write: no persister is installed and its entity is not an entity() value, so it has no repository`,
      fix: 'defineFactory(<the entity() value>, …) — create() then writes through its repository — or usePersister(entityPersister({ driver })) in the test preload, or build() for an in-memory row',
    });
  }
}

/**
 * `sealNetwork()` always sets the original `fetch` before installing its patch, so this can only
 * fire if `unsealNetwork()` ran concurrently with a request from the same seal — a race, not a
 * reachable steady state.
 */
export class NetworkRaceError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_NETWORK_RACE',
      cause: 'sealed network lost its original fetch mid-request',
      fix: 'do not call unsealNetwork() while a request from the same test is still in flight',
    });
  }
}
