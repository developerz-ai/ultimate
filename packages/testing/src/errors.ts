// The X_* codes owned by @ultimat3/testing. A test failure has to be as actionable as a runtime
// failure — the fix line here is the mock to add, the service to start, or the seed to freeze.
import {
  registerErrorCodes,
  renderCauseValue,
  renderFixLiteral,
  UltimateError,
} from '@ultimat3/core';
// Type-only, so the cycle with the guard that throws it is erased at build: the code is declared
// here because this file is the package's code registry, and the shape it reports lives with the
// sampler that produces it.
import type { RegistryLeak } from './registry-leak-guard';

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
  'X_TEST_NETWORK_RACE',
  'X_TEST_FACTORY_TRAIT_UNKNOWN',
  'X_TEST_FACTORY_NOT_PERSISTED',
  'X_TEST_REGISTRY_LEAK',
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
  X_TEST_NETWORK_RACE: 'a request raced unsealNetwork() and lost the patched fetch',
  X_TEST_FACTORY_TRAIT_UNKNOWN: 'a factory was asked for a trait it does not declare',
  X_TEST_FACTORY_NOT_PERSISTED: 'a factory create() had nowhere to write the row',
  X_TEST_REGISTRY_LEAK: 'a test file left a process-global registry dirty',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(TESTING_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

const docsFor = (code: TestingErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** A test reached the network without a mock or an allowlist entry. Always a bug, never a flake. */
export class NetworkSealedError extends UltimateError {
  constructor(input: { url: string; method: string; allowed: readonly string[] }) {
    super({
      code: 'X_TEST_NETWORK_SEALED',
      cause: `${input.method} ${input.url} was not mocked (allowed hosts: ${
        input.allowed.length > 0 ? input.allowed.join(', ') : 'none'
      })`,
      fix: `mockFetch('${input.url}', () => new Response('{}')) — or allowHost('${hostOf(input.url)}') if it must be real`,
      docs: docsFor('X_TEST_NETWORK_SEALED'),
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
      docs: docsFor('X_TEST_DB_UNAVAILABLE'),
    });
  }
}

/** Two runs of the same test produced different values. The seed or the clock is not frozen. */
export class NondeterministicError extends UltimateError {
  constructor(input: { what: string; first: string; second: string }) {
    super({
      code: 'X_TEST_NONDETERMINISTIC',
      cause: `${input.what} produced "${input.first}" then "${input.second}"`,
      fix: 'wrap the test in frozenClock() / seededRandom(), or remove the wall-clock read',
      docs: docsFor('X_TEST_NONDETERMINISTIC'),
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
      docs: docsFor('X_TEST_FIXTURE_UNKNOWN'),
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
      docs: docsFor('X_TEST_FIXTURE_UNAVAILABLE'),
    });
  }
}

export const fixtureUnavailable = (name: string, needs: string): UltimateError =>
  new FixtureUnavailableError({ name, needs });

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
      docs: docsFor('X_TEST_NETWORK_OFFLINE'),
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
      docs: docsFor('X_TEST_EVAL_THRESHOLD'),
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
      docs: docsFor('X_TEST_SCHEMA_EXPECTED'),
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
      docs: docsFor('X_TEST_JOB_EXPECTED'),
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
      docs: docsFor('X_TEST_FACTORY_TRAIT_UNKNOWN'),
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
      cause: `factory "${input.table}".create() ran with no persister in this process`,
      fix: 'usePersister({ insert: (table, row) => repoFor(table).insert(row) }) in the test preload — or build() for an in-memory row',
      docs: docsFor('X_TEST_FACTORY_NOT_PERSISTED'),
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
      docs: docsFor('X_TEST_NETWORK_RACE'),
    });
  }
}

/**
 * Every value in this message is uncontrolled: the path arrives from `Bun.plugin`'s `onLoad`, and
 * the names are whatever the app under test passed to `declareTags()` / `registerTier()`. So the
 * sentence renders them (bounded, never throwing while describing a leak) and the command quotes
 * them (a fix has to parse after a path with a space or a quote in it lands in the middle of it).
 */
const describeLeak = (leak: RegistryLeak): string => {
  const left = [
    ...(leak.tags.length > 0 ? [`cache tags declared ${renderCauseValue(leak.tags)}`] : []),
    ...(leak.tiers.length > 0 ? [`cache tiers registered ${renderCauseValue(leak.tiers)}`] : []),
  ];
  return `${renderCauseValue(leak.file)} left ${left.join(' and ')} after its last test`;
};

/** The placeholder is the cause's own sentence: it already names every file, in order. */
const FILE_PLACEHOLDER = '<the file the cause names>';

/**
 * The edit, spelled as the lines to paste — the imports included, since neither call is global.
 *
 * Both repairs isolate; neither resets. `afterAll(resetTiers)` was the first spelling of the tier
 * half and it is the bug wearing the fix's clothes: it drops the tiers, the revalidator and both
 * logs a NEIGHBOUR registered, and the guard reports additions only, so the damage lands on an
 * innocent file with nothing pointing back here. An error whose instruction causes the next defect
 * is worse than no instruction.
 */
const repairFor = (leak: RegistryLeak): string => {
  const imports: string[] = [];
  const calls: string[] = [];
  if (leak.tags.length > 0) {
    imports.push('isolateDeclaredTags');
    calls.push('const restoreTags = isolateDeclaredTags(); afterAll(restoreTags);');
  }
  if (leak.tiers.length > 0) {
    imports.push('isolateTiers');
    calls.push('const restoreTiers = isolateTiers(); afterAll(restoreTiers);');
  }
  const file = renderFixLiteral(leak.file, FILE_PLACEHOLDER);
  return `in ${file} add: import { ${imports.join(', ')} } from '@ultimat3/cache'; ${calls.join(' ')}`;
};

/**
 * One error for every leaker in the run, not one per file: the run has already finished by the
 * time the last file can be judged, and two throws would report the second as an unhandled one.
 * The trailing command reproduces the failure on its own — the guard judges each file against its
 * own baseline, so one leaking file fails a one-file run exactly as it failed the whole suite.
 */
export class RegistryLeakError extends UltimateError {
  constructor(input: { readonly leaks: readonly RegistryLeak[] }) {
    const files = input.leaks.map((leak) => renderFixLiteral(leak.file, FILE_PLACEHOLDER));
    super({
      code: 'X_TEST_REGISTRY_LEAK',
      cause: input.leaks.map(describeLeak).join('; '),
      fix: `${input.leaks.map(repairFor).join('; ')} — then re-run: bun test ${files.join(' ')}`,
      docs: docsFor('X_TEST_REGISTRY_LEAK'),
    });
  }
}
