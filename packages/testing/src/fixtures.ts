// Fixture injection: `test('…', async ({ seed, actorFor }) => …)`.
//
// Bun's `test` passes a `done` callback as the first argument, so destructuring a fixture bag
// from it yields `undefined` for every key — silently, because the failure only surfaces later
// as "cannot read property of undefined", naming nothing useful. This wraps `bun:test` so the
// first argument is the fixture bag instead.
//
// Fixtures are registered by the app, not hardcoded here: `seed` and `billing` mean nothing to
// the framework. `defineFixtures` merges, so a package can add one without knowing the others.

import { test as bunTest } from 'bun:test';
import { fixtureUnknown } from './errors';
import type { TestClock } from './fixture-clock';
import type { SignIn, Subscribe, TestBudget, TestDeploy } from './fixture-drivers';
import type { RunJobs } from './fixture-jobs';
import type { TestMail } from './fixture-mail';
import type { TestNetwork } from './fixture-network';
import type { TestStatements } from './fixture-statements';
import type { PageLike } from './test-types';

/** Built once per test, on first use. */
export type FixtureFactory<T = unknown> = () => T | Promise<T>;

/** The registry's own shape, where the built type is erased — what `fixtureSnapshot()` hands back. */
export type FixtureMap = Readonly<Record<string, FixtureFactory>>;

/**
 * What a test body receives. Everything the framework owns is declared here and registered by the
 * preload; apps widen it by augmenting `Fixtures`:
 *
 * ```ts
 * declare module '@ultimat3/testing' {
 *   interface Fixtures {
 *     seed: (name: string) => SeedHandle;
 *   }
 * }
 * ```
 *
 * The last five are declared but driver-backed: destructuring one in a process with no driver
 * fails as `X_TEST_FIXTURE_UNAVAILABLE`, naming what is missing. Typed here anyway, because the
 * type is the contract a driver implements — see `fixture-drivers.ts`.
 */
export interface Fixtures {
  readonly clock: TestClock;
  readonly mail: TestMail;
  readonly network: TestNetwork;
  readonly runJobs: RunJobs;
  readonly statements: TestStatements;
  readonly budget: TestBudget;
  readonly deploy: TestDeploy;
  readonly page: PageLike;
  readonly signIn: SignIn;
  readonly subscribe: Subscribe;
}

/**
 * A registration bag, with every name the framework declares held to the type it was declared
 * with. A driver that registers a half-built `page` is a compile error at the registration, rather
 * than a missing method three awaits into some later test — the same reason the name is declared
 * at all. A key `Fixtures` does not name is the app's, and takes any factory: the framework has
 * nothing to check it against until the app augments `Fixtures`.
 *
 * Written over the argument's own keys rather than as an intersection, so a value typed only as
 * `FixtureMap` — a snapshot on its way back into the registry — still satisfies it.
 */
export type FixtureRegistration<M> = {
  readonly [K in keyof M]: K extends keyof Fixtures ? FixtureFactory<Fixtures[K]> : FixtureFactory;
};

const registry = new Map<string, FixtureFactory>();

export function defineFixtures<M extends FixtureRegistration<M>>(map: M): void {
  for (const [name, factory] of Object.entries(map as FixtureMap)) registry.set(name, factory);
}

export function clearFixtures(): void {
  registry.clear();
}

export function registeredFixtures(): readonly string[] {
  return [...registry.keys()].sort();
}

/**
 * A copy of the registry. The registry is process-global and bun shares one process across
 * files, so a test that needs an empty one snapshots first and hands it back afterwards —
 * otherwise every later file silently loses the fixtures the preload registered.
 */
export function fixtureSnapshot(): FixtureMap {
  return Object.fromEntries(registry);
}

const CLOSERS: Readonly<Record<string, string>> = { '{': '}', '[': ']', '(': ')' };
const QUOTES = new Set(['"', "'", '`']);

/**
 * The pattern's own top-level segments: the `}` that closes the opening `{`, and the commas at
 * depth zero inside it. `indexOf('}')` stopped at the FIRST closer, so `{ mail, clock: { now },
 * network }` lost `network` and `{ clock = { now: 1 }, mail }` lost both — silently, and a fixture
 * that is never built reads as `undefined` in the body, which is the failure this module exists to
 * turn into a message. Strings are skipped so a default like `{ role = 'a, b' }` is one segment.
 */
function patternSegments(source: string, open: number): readonly string[] | undefined {
  const segments: string[] = [];
  const stack: string[] = [];
  let start = open + 1;
  let quote: string | undefined;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (QUOTES.has(char)) {
      quote = char;
      continue;
    }
    const closer = CLOSERS[char];
    if (closer !== undefined) {
      stack.push(closer);
      continue;
    }
    if (stack.length > 0 && char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        segments.push(source.slice(start, index));
        return segments;
      }
      continue;
    }
    if (char === ',' && stack.length === 1) {
      segments.push(source.slice(start, index));
      start = index + 1;
    }
  }
  // An unbalanced pattern is not one this can read; building nothing beats guessing a name.
  return undefined;
}

/**
 * The names a body destructures, read from its source.
 *
 * Reading source is unusual enough to justify: the alternative is building every registered
 * fixture for every test, so one test that touches `page` would start a browser for the whole
 * suite. Playwright resolves fixtures the same way and for the same reason. Only the first
 * parameter is inspected, and only its top-level keys.
 */
export function requestedFixtures(body: (...args: never[]) => unknown): readonly string[] {
  const source = body.toString();
  const open = source.indexOf('{');
  if (open === -1) return [];
  // Bail if the brace opens a body rather than a destructuring pattern — `async () => {`.
  const beforeBrace = source.slice(0, open);
  if (/\)\s*(?::[^=]*)?=>\s*$/.test(beforeBrace) || /\)\s*$/.test(beforeBrace)) return [];
  return (patternSegments(source, open) ?? [])
    .map((part) => (part.split(/[:=]/)[0] ?? '').trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

export type FixtureBody = (fixtures: Fixtures) => void | Promise<void>;

/**
 * A fixture that installs process-global state — the ambient job driver, the ambient mail
 * driver — implements one of the standard disposal symbols to put it back. Bun shares one
 * process across every test file, so a fixture that skips this does not leak within its own
 * test: it leaks into every file that runs after it, and the failure surfaces somewhere else.
 */
type MaybeDisposable = {
  readonly [Symbol.asyncDispose]?: () => PromiseLike<void> | void;
  readonly [Symbol.dispose]?: () => void;
};

const disposerOf = (value: unknown): (() => PromiseLike<void> | void) | undefined => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  const target = value as MaybeDisposable;
  const asyncDispose = target[Symbol.asyncDispose];
  if (typeof asyncDispose === 'function') return () => asyncDispose.call(target);
  const dispose = target[Symbol.dispose];
  return typeof dispose === 'function' ? () => dispose.call(target) : undefined;
};

/**
 * Build what the body asked for, run it, dispose in reverse. Split out of `fixtureTest` because
 * that one hands its callback to bun and returns nothing — teardown is the part most worth
 * testing, and it cannot be observed through a registration. Not in the package's public API:
 * `fixtureTest` stays the one way to write a test with fixtures.
 */
export async function runWithFixtures(body: FixtureBody): Promise<void> {
  const wanted = requestedFixtures(body as (...args: never[]) => unknown);
  // Partial by construction — only what the body destructured is built. Handed over as the
  // full `Fixtures` because the keys came from that same body: a key it did not name is a key
  // it cannot read, so the missing ones are unobservable.
  const bag: Partial<Fixtures> & Record<string, unknown> = {};
  const built: unknown[] = [];
  // Boxed rather than a bare `unknown`, so a body that throws a falsy value still reports.
  let failure: { readonly error: unknown } | undefined;
  try {
    for (const key of wanted) {
      const factory = registry.get(key);
      // Naming the registered set turns "undefined is not an object" into a fixable message.
      if (factory === undefined) throw fixtureUnknown(key, registeredFixtures());
      const value = await factory();
      built.push(value);
      bag[key] = value;
    }
    await body(bag as Fixtures);
  } catch (error) {
    failure = { error };
  }

  // Every disposer runs even when an earlier one throws: a fixture that cannot clean up must
  // not strand the ones built before it. The body's own failure wins, because a teardown error
  // that replaced it would hide the assertion that actually broke.
  for (const value of built.reverse()) {
    try {
      await disposerOf(value)?.();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
}

/**
 * `test` with fixtures. Only what the body destructures is built, and each is awaited before
 * the body runs — so a body reads `seed('dev')` directly instead of awaiting every fixture.
 *
 * Teardown runs in reverse build order whether the body passed or threw: a failing assertion
 * must not be the reason the next file inherits a queue.
 */
export function fixtureTest(name: string, body: FixtureBody): void {
  bunTest(name, () => runWithFixtures(body));
}
