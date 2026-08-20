// The fixtures the framework DECLARES but cannot build in this process: a browser for `page`,
// `budget`, `signIn` and `deploy`; a replicator feeding a live-query registry for `subscribe`.
// Each is a type a driver implements, plus a factory that says what is missing until one does.

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
 * What `query.live(input, { actor })` resolves to, named structurally so `@ultimat3/testing` does
 * not take a dependency on `@ultimat3/query` for one type. The real `LiveQuery` satisfies it.
 *
 * NOT what `query.as(actor, input)` resolves to, which is a ROW ARRAY — and the difference is
 * invisible until a driver exists. `examples/dummy`'s five `subscribe` tests all call
 * `subscribe(liveFeed.as(actor, input))`, which is `TS2345` against `Subscribe` below and has
 * never been read, because that app's `typecheck` is pinned red in `scripts/lib/gated-apps.ts`.
 * A driver built to satisfy those call sites would have to accept a row array — and a `subscribe`
 * loose enough to do that proves nothing, which is strictly worse than the fixture being
 * unavailable, because it then reads as coverage.
 */
export interface LiveTarget {
  readonly name: string;
  readonly queryHash: string;
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

export type Subscribe = <R extends object>(
  target: LiveTarget | Promise<LiveTarget>,
) => Promise<LiveFeed<R>>;

export const DRIVER_FIXTURE_NAMES = ['budget', 'deploy', 'page', 'signIn', 'subscribe'] as const;

export type DriverFixtureName = (typeof DRIVER_FIXTURE_NAMES)[number];

/** What each one is waiting on. `Record` over the name union, so the two lists cannot drift. */
export const DRIVER_FIXTURE_NEEDS: Readonly<Record<DriverFixtureName, string>> = {
  budget: 'the byte counts a browser run measures off the built output',
  deploy: 'a second build to switch the running app to',
  page: 'a browser driving the built app',
  signIn: 'a browser session against the app’s own sign-in route',
  subscribe:
    'an in-process replicator feeding the live-query registry, and a caller that hands it ' +
    'query.live(input, { actor }) — query.as() resolves to ROWS, which is not a LiveTarget',
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
  subscribe: unavailableFixture('subscribe'),
});
