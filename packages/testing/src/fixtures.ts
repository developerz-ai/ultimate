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
import type { RunJobs } from './fixture-jobs';
import type { TestMail } from './fixture-mail';

/** Built once per test, on first use. */
export type FixtureFactory<T = unknown> = () => T | Promise<T>;

export type FixtureMap = Readonly<Record<string, FixtureFactory>>;

/**
 * What a test body receives. The three the framework owns are declared here and registered by
 * the preload; apps widen it by augmenting `Fixtures`:
 *
 * ```ts
 * declare module '@ultimat3/testing' {
 *   interface Fixtures {
 *     seed: (name: string) => SeedHandle;
 *   }
 * }
 * ```
 */
export interface Fixtures {
  readonly clock: TestClock;
  readonly mail: TestMail;
  readonly runJobs: RunJobs;
}

const registry = new Map<string, FixtureFactory>();

export function defineFixtures(map: FixtureMap): void {
  for (const [name, factory] of Object.entries(map)) registry.set(name, factory);
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
  const close = source.indexOf('}', open);
  if (close === -1) return [];
  // Bail if the brace opens a body rather than a destructuring pattern — `async () => {`.
  const beforeBrace = source.slice(0, open);
  if (/\)\s*(?::[^=]*)?=>\s*$/.test(beforeBrace) || /\)\s*$/.test(beforeBrace)) return [];
  return source
    .slice(open + 1, close)
    .split(',')
    .map((part) => (part.split(':')[0] ?? '').trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

export type FixtureBody = (fixtures: Fixtures) => void | Promise<void>;

/**
 * `test` with fixtures. Only what the body destructures is built, and each is awaited before
 * the body runs — so a body reads `seed('dev')` directly instead of awaiting every fixture.
 */
export function fixtureTest(name: string, body: FixtureBody): void {
  bunTest(name, async () => {
    const wanted = requestedFixtures(body as (...args: never[]) => unknown);
    // Partial by construction — only what the body destructured is built. Handed over as the
    // full `Fixtures` because the keys came from that same body: a key it did not name is a key
    // it cannot read, so the missing ones are unobservable.
    const bag: Partial<Fixtures> & Record<string, unknown> = {};
    for (const key of wanted) {
      const factory = registry.get(key);
      // Naming the registered set turns "undefined is not an object" into a fixable message.
      if (factory === undefined) throw fixtureUnknown(key, registeredFixtures());
      bag[key] = await factory();
    }
    await body(bag as Fixtures);
  });
}
