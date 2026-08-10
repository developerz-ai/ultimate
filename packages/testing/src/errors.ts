// The X_* codes owned by @ultimat3/testing. A test failure has to be as actionable as a runtime
// failure — the fix line here is the mock to add, the service to start, or the seed to freeze.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const TESTING_ERROR_CODES = [
  'X_TEST_NETWORK_SEALED',
  'X_TEST_NETWORK_OFFLINE',
  'X_TEST_DB_UNAVAILABLE',
  'X_TEST_NONDETERMINISTIC',
  'X_TEST_FIXTURE_UNKNOWN',
  'X_TEST_FIXTURE_UNAVAILABLE',
] as const;

export type TestingErrorCode = (typeof TESTING_ERROR_CODES)[number];

export const TESTING_ERROR_TITLES: Readonly<Record<TestingErrorCode, string>> = {
  X_TEST_NETWORK_SEALED: 'a test tried to reach the network',
  X_TEST_NETWORK_OFFLINE: 'the test network is offline',
  X_TEST_DB_UNAVAILABLE: 'no Postgres for the test template',
  X_TEST_NONDETERMINISTIC: 'a test read wall-clock time or unseeded randomness',
  X_TEST_FIXTURE_UNKNOWN: 'a test requested a fixture nobody registered',
  X_TEST_FIXTURE_UNAVAILABLE: 'a declared fixture has no driver in this process',
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
