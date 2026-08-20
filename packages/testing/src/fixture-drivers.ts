// The fixtures the framework DECLARES but cannot build in this process: a browser for `page`,
// `budget`, `signIn` and `deploy` — all four wait for a browser or a second build.
// Each is a type a driver implements, plus a factory that says what is missing until one does.

import type { Actor } from '@ultimat3/core';
import { fixtureUnavailable } from './errors';
import type { FixtureFactory, Fixtures } from './fixtures';

/** Per-route byte budgets, measured off the built output rather than declared. */
export interface TestBudget {
  jsBytes(route: string): Promise<number>;
}

/** Put the browser session in this member's shoes. A row, because the app owns what a member is. */
export type SignIn = (member: Readonly<Record<string, unknown>>) => Promise<void>;

/** Version skew: same app, new immutable build id, while the page stays open. */
export interface TestDeploy {
  newBuild(): Promise<void>;
}

/**
 * The declared query itself — `liveFeed`, not a call to it. Named structurally so this package takes
 * no static dependency on `@ultimat3/query` for one type; every `query()` satisfies it, because
 * `registerQueries()` stamps the name a subscription is keyed by.
 *
 * It was `{ name, queryHash }` — "what `query.live(input, { actor })` resolves to" — and that shape
 * cannot be subscribed to: the node keys a subscription by `(name, input)`, and a hash is the input
 * already thrown away. The five `subscribe` tests in `examples/dummy` wrote
 * `subscribe(liveFeed.as(actor, input))`, which resolves to a ROW ARRAY and was `TS2345` against
 * either shape — never read, because that app's `typecheck` is pinned red in
 * `scripts/lib/gated-apps.ts`. The call is now `subscribe(liveFeed, input, actor)`: the query, its
 * input, and who is asking — the three things a subscribe frame carries.
 */
export interface LiveTarget {
  readonly name: string;
}

export interface LiveFeedPatch<R extends object> {
  readonly op: 'insert' | 'update' | 'delete';
  readonly row: R;
}

/** One subscriber's view: what it holds, what it was sent, and how it got there. */
export interface LiveFeed<R extends object> {
  rows(): readonly R[];
  row(id: string): R | undefined;
  /** The optimistic twin a mutator applied locally, before the server confirmed it. */
  local(id: string): R | undefined;
  patches(): readonly LiveFeedPatch<R>[];
  /** Resolves when every patch in flight has been applied — never a sleep. */
  settled(): Promise<void>;
  lsn(): string;
  /** Set when a reconnect resumed from a cursor; undefined when it resnapshotted. */
  resubscribedFrom(): string | undefined;
  /** How many snapshots this subscriber received. A resume that refetched shows up here. */
  snapshots(): number;
}

/**
 * `actor` is the third argument rather than something baked into the target, because that is where
 * the framework itself puts it: `liveQueryDefinition` builds the shared window with NO subject
 * (`ToLiveOptions.enforce: false`) and decides per subscriber at subscribe time. A `subscribe` that
 * took the actor inside the target would be describing a design the node does not have.
 */
export type Subscribe = <R extends object>(
  target: LiveTarget,
  input: Readonly<Record<string, unknown>>,
  actor?: Actor | null,
) => Promise<LiveFeed<R>>;

export const DRIVER_FIXTURE_NAMES = ['budget', 'deploy', 'page', 'signIn'] as const;

export type DriverFixtureName = (typeof DRIVER_FIXTURE_NAMES)[number];

/** What each one is waiting on. `Record` over the name union, so the two lists cannot drift. */
export const DRIVER_FIXTURE_NEEDS: Readonly<Record<DriverFixtureName, string>> = {
  budget: 'the byte counts a browser run measures off the built output',
  deploy: 'a second build to switch the running app to',
  page: 'a browser driving the built app',
  signIn: 'a browser session against the app’s own sign-in route',
};

/**
 * Declared rather than left out, because the name is the contract. An app that registered its own
 * `page` would be deciding for itself what a page is, and two apps would then disagree — the same
 * reason `clock` is not an app fixture. And an unregistered name fails as X_TEST_FIXTURE_UNKNOWN,
 * whose fix ("register it") is the wrong instruction: what is missing is a driver, not a
 * registration. So the name resolves, and asking for it without a driver says so.
 *
 * Throws when built, not when used. Building is where the test is still on its own first line, so
 * the failure names the fixture instead of surfacing three awaits later as a missing method.
 */
export const unavailableFixture =
  <K extends DriverFixtureName>(name: K): FixtureFactory<Fixtures[K]> =>
  () => {
    throw fixtureUnavailable(name, DRIVER_FIXTURE_NEEDS[name]);
  };

/** Each declaration carries the type its driver must satisfy — `defineFixtures` holds it to that. */
export type DriverFixtures = { readonly [K in DriverFixtureName]: FixtureFactory<Fixtures[K]> };

/**
 * The declared bag, as `defineFixtures` takes it. A driver overrides these the ordinary way —
 * `defineFixtures` merges, last registration wins.
 */
export const driverFixtures = (): DriverFixtures => ({
  budget: unavailableFixture('budget'),
  deploy: unavailableFixture('deploy'),
  page: unavailableFixture('page'),
  signIn: unavailableFixture('signIn'),
});
