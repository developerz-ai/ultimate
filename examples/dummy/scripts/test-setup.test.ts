/**
 * unit — the preload's own contract, which nothing else in the suite states: a seeded row has to
 * land in the driver the APP reads through, and the actor a fixture mints has to be the same
 * identity the seeded rows name. Both were wrong, and both failed three suites away as a policy
 * denial or a missing org rather than as a fixture.
 */

// The preload, imported by name as well: `bunfig.toml` applies it only to a run started in this
// app, and a run from the repository root (`bun test scripts/` matches this path) otherwise found no
// `seed` fixture and reported X_TEST_FIXTURE_UNKNOWN. One module, so the in-app run loads it once.
import './test-setup';
import { db } from '@postly/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { expect, test, testNetwork } from '@ultimat3/testing';
import { browserNetwork } from './test-setup';

test('a seeded row is visible through the handle the app reads', async ({ seed, actorFor }) => {
  const { acme, draft, ada } = await seed('dev').pick({
    acme: 'org:acme',
    draft: 'post:draft-money',
    ada: 'member:ada',
  });

  // `plans` carries no tenant column, so this half needs no actor: a seed writing into a driver of
  // its own leaves the app's `db` answering with an empty table, which is what every X_ORG_NOT_FOUND
  // and every null `row:` loader in the contract and job suites actually was.
  expect((await db.plans.all()).length).toBeGreaterThan(0);

  // And the tenant-scoped half, through the same scope an action's read runs under.
  const found = await runWithContext(ctxOf({ actor: actorFor(ada) }), () =>
    db.posts.where({ orgId: acme.id, id: draft.id }).one(),
  );
  expect(found?.id).toBe(draft.id);
});

test('the actor a fixture mints is the member a row names as its author', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });

  // `memberOf()` reads the member id off `actor.id` and `AppActor.id` is a `MemberId`, so an actor
  // minted from the user id owns nothing it wrote: `mayPublish` compares it against `posts.authorId`.
  expect(actorFor(bruno).id).toBe(String(draft['authorId']));
  expect(actorFor(bruno).orgId).toBe(String(draft['orgId']));
});

test('each seed call starts from an empty graph rather than the last one', async ({
  seed,
  actorFor,
}) => {
  const { acme, ada } = await seed('dev').pick({ acme: 'org:acme', ada: 'member:ada' });
  const asAda = <T>(read: () => Promise<T>): Promise<T> =>
    runWithContext(ctxOf({ actor: actorFor(ada) }), read);

  // A row the seed does not write: the driver is process-wide now, so a test's own writes are
  // what the next test would otherwise inherit — the reason `x test contract` and `x test job`
  // cannot be allowed to depend on the order their files run in.
  const stray = await asAda(() =>
    db.posts.insert({
      orgId: acme.id,
      authorId: String(ada.id),
      slug: 'a-row-the-seed-never-wrote',
      title: 'A row the seed never wrote',
      excerpt: 'Left behind by the test before this one.',
      body: 'x'.repeat(600),
    }),
  );

  await seed('dev').pick({ acme: 'org:acme' });

  expect(await asAda(() => db.posts.where({ orgId: acme.id, id: stray.id }).one())).toBeNull();
});

test('a browser cable a test pulled is back in before its teardown is over', async () => {
  const seen: string[] = [];
  let restore = (): void => expect.unreachable('the cable was never asked to go back in');
  // A browser's switch is a round trip per tab and per worker: `offline(false)` resolves LATER.
  const session = {
    offline: (enabled: boolean): Promise<void> => {
      seen.push(enabled ? 'cut' : 'restore asked');
      if (enabled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        restore = (): void => {
          seen.push('restored');
          resolve();
        };
      });
    },
  };
  const network = browserNetwork(testNetwork(), session);
  await network.offline();

  // The disposer the fixture runner takes (`runWithFixtures`): the async one, awaited.
  const teardown = network[Symbol.asyncDispose]().then(() => seen.push('teardown over'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Still open: the NEXT test's first navigation must not start under a half-restored browser.
  expect(seen).toEqual(['cut', 'restore asked']);

  restore();
  await teardown;
  expect(seen).toEqual(['cut', 'restore asked', 'restored', 'teardown over']);
});
