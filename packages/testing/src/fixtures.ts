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

/** Built once per test, on first use. */
export type FixtureFactory<T = unknown> = () => T | Promise<T>;

export type FixtureMap = Readonly<Record<string, FixtureFactory>>;

/**
 * What a test body receives. Apps widen it by augmenting `Fixtures`:
 *
 * ```ts
 * declare module '@ultimat3/testing' {
 *   interface Fixtures {
 *     seed: (name: string) => Promise<SeedHandle>;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: the augmentation target — apps declare into it.
export interface Fixtures {}

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
    const bag: Record<string, unknown> = {};
    for (const key of wanted) {
      const factory = registry.get(key);
      // Naming the registered set turns "undefined is not an object" into a fixable message.
      if (factory === undefined) throw fixtureUnknown(key, registeredFixtures());
      bag[key] = await factory();
    }
    await body(bag as Fixtures);
  });
}
