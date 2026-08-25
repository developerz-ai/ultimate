// Postly's test preload: the fixtures the APP owns, which is two of them — the seed graph, and
// how a member becomes an actor. Everything else in the bag arrives with the framework's own
// preload, imported below, so an app registers only what the framework cannot know.

// Imported by package name, exactly as a generated app writes it: Postly is a workspace member,
// so `@ultimat3/testing` resolves here through the same symlink `x new` produces — no relative
// reach into the framework's sources, and nothing in this file that a real app would not write.
import '@ultimat3/testing/preload';
// The registration pass, and it belongs HERE rather than in a test file: importing the API stamps
// each export name onto its declaration, which is what gives a projection a stable name to project
// under. A test in `app/` that imported it would be `app/` reaching into `api/` at runtime — the
// boundary `x verify` rejects with `X_BOUNDARY_VIOLATION`, because it is the edge along which a
// page could call a handler instead of the typed client. The preload is outside both, runs once
// for the whole suite, and is already where the app says what its tests need.
import '../apps/web/api';
import type { Comment, Member, Org, Post } from '@postly/db';
import { driver as appDriver } from '@postly/db';
import { type Actor, assert, userActor } from '@ultimat3/core';
import type { Driver, EntityCore, Repo, Seed } from '@ultimat3/entity';
import { seedId } from '@ultimat3/entity';
import { defineFixtures } from '@ultimat3/testing';

/** Every seeded row carries an id; the rest of the columns are the entity's business. */
export interface SeedRow {
  readonly id: string;
  readonly [column: string]: unknown;
}

/**
 * A seed label is `<entity>:<name>` — `id('member:ada')`, `id('post:draft-money')` — so the prefix
 * already says which table the row came from, and `pick` can answer with that entity's own row
 * type instead of a bag of `unknown`.
 *
 * It answered `SeedRow` for every label until 2026-08-24, and the index signature is `unknown`:
 * `draft.orgId` was `unknown` at 21 call sites, which is neither assignable to an action's
 * `orgId: string` nor comparable with the view a test asserts against. Widening the index
 * signature would have made those compile and proved nothing — the prefix is the fact, so it is
 * the prefix that carries the type.
 *
 * A label with no entity prefix (`plans` has no seeded id; `user:…` labels are userId VALUES, not
 * rows) still answers `SeedRow`, because nothing here knows what it is.
 */
export type SeedRowFor<Label extends string> = Label extends `member:${string}`
  ? Member
  : Label extends `org:${string}`
    ? Org
    : Label extends `post:${string}`
      ? Post
      : Label extends `comment:${string}`
        ? Comment
        : SeedRow;

export interface SeedHandle {
  /** `pick({ draft: 'post:draft-money' })` — seed labels in, rows out, aliased at the call site. */
  pick<const M extends Readonly<Record<string, string>>>(
    labels: M,
  ): Promise<{ readonly [K in keyof M]: SeedRowFor<M[K]> }>;
}

const idOf = (row: unknown): string | undefined => {
  const value = (row as { readonly id?: unknown }).id;
  return typeof value === 'string' ? value : undefined;
};

/**
 * Rows are captured on the way in rather than read back out: a tenant-scoped entity refuses an
 * unscoped read, so a fixture would have to name the org before it could fetch the org. Insert
 * still runs `$parse` and the invariants, so seeding still tests the schema.
 *
 * It decorates the driver it is given rather than building one, and the caller gives it the
 * PROCESS driver — see `handleFor`.
 */
const capturingDriver = (base: Driver, rows: Map<string, SeedRow>): Driver => {
  return {
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const inner = base.repo(entity);
      const capture = (row: unknown): void => {
        const id = idOf(row);
        if (id !== undefined) rows.set(id, row as SeedRow);
      };
      return {
        ...inner,
        insert: async (values, options) => {
          const row = await inner.insert(values, options);
          capture(row);
          return row;
        },
        // `defineSeed`'s `insert` is ONE `upsertAll(rows, { onMatch: 'nothing' })` per call — that
        // is what makes a seed replayable on Postgres — so a seeded row never reaches `insert`.
        // Captured from the INCOMING batch and not from the result: a row already stored is
        // skipped and absent from `returning *`, and a fixture still needs to find it.
        upsertAll: async (batch, args) => {
          const written = await inner.upsertAll(batch, args);
          for (const row of batch) capture(row);
          return written;
        },
      };
    },
  };
};

/**
 * A fresh graph per call, in the driver the APP reads through — imported from `@postly/db`, not
 * rebuilt here. A seed run against a driver of its own writes rows nothing else in the process can
 * see, and every action, job and query under test reads an empty table. It failed three suites
 * away as `X_ORG_NOT_FOUND`, as a policy denial on a null `row:`, and as a `posts.authorId`
 * invariant. It read `defaultDriver()` until 2026-08-23, which agreed with the app only for as
 * long as the app named no driver at all (#270).
 *
 * `reset?.()` first, because that driver is process-wide: fresh is now something this call has to
 * do rather than something a new object gives it for free. Postgres has no `reset`, and the
 * optional call is the whole of the difference.
 */
const handleFor = (seed: Seed): SeedHandle => {
  const rows = new Map<string, SeedRow>();
  const driver = appDriver;
  driver.reset?.();
  const ready = seed.run({ driver: capturingDriver(driver, rows) });

  return {
    pick: async <const M extends Readonly<Record<string, string>>>(labels: M) => {
      await ready;
      const picked: Record<string, SeedRow> = {};
      for (const [alias, label] of Object.entries(labels)) {
        const row = rows.get(seedId(label));
        assert(
          row !== undefined,
          `seed "${seed.name}" has no row labelled "${label}"`,
          `add it to packages/db/seeds/${seed.name}.ts with id: id('${label}')`,
        );
        picked[alias] = row;
      }
      return picked as { readonly [K in keyof M]: SeedRowFor<M[K]> };
    },
  };
};

/** Imported on demand, so a test that never seeds never loads the entity graph. */
const createSeed = async (): Promise<(name: string) => SeedHandle> => {
  const { dev } = await import('../packages/db/seeds/dev');
  const seeds: Readonly<Record<string, Seed>> = { dev };
  return (name) => {
    const seed = seeds[name];
    assert(
      seed !== undefined,
      `no seed named "${name}" — known seeds: ${Object.keys(seeds).join(', ')}`,
      'x db seed --list, then use one of the names it prints',
    );
    return handleFor(seed);
  };
};

/**
 * A member row is the actor: same org, and its membership role is the authz role.
 *
 * `id` is the MEMBER row's id, never `userId`. Postly's identity is the membership —
 * `AppActor.id` is a `MemberId`, `memberOf()` reads the member id straight off `actor.id`, and
 * `posts.authorId` holds a member id — so an actor minted from the user id owns nothing it wrote
 * and `mayPublish` denies its author their own draft.
 */
const actorFor = (member: SeedRow): Actor =>
  userActor({
    id: member.id,
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  });

/**
 * The two names above, DECLARED — the augmentation `@ultimat3/testing`'s own `Fixtures` doc
 * comment asks an app to write, and the half Postly never wrote. Without it every
 * `test('…', async ({ seed, actorFor }) => …)` in this app was `TS2339: Property 'seed' does not
 * exist on type 'Fixtures'` — 48 of the 116 this app's `typecheck` measured on 2026-08-24, one
 * per destructuring site across seven files, for one missing declaration.
 *
 * It lives HERE, beside `defineFixtures`, and not in `types/`: a registration and its declaration
 * that can be edited apart are two things to keep in step, and the one that goes stale is the
 * declaration. Global by construction — a `declare module` in any file of the program reaches
 * every test file, so no test imports this one.
 */
declare module '@ultimat3/testing' {
  interface Fixtures {
    /** `seed('dev')` — the seed by name, its rows picked by label. */
    readonly seed: (name: string) => SeedHandle;
    /** A seeded member row becomes the actor every policy in this app decides about. */
    readonly actorFor: (member: SeedRow) => Actor;
  }
}

/**
 * Two names, and deliberately no more. `clock`, `mail`, `network`, `runJobs` and the driver-backed
 * `page`, `budget`, `signIn`, `deploy` and `subscribe` all arrive with the framework's preload:
 * registering `page` here would be Postly deciding for itself what a page is, and two apps would
 * then disagree about it.
 */
defineFixtures({
  seed: createSeed,
  actorFor: () => actorFor,
});
