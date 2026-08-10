// Postly's test preload: the fixtures the APP owns, which is two of them — the seed graph, and
// how a member becomes an actor. Everything else in the bag arrives with the framework's own
// preload, imported below, so an app registers only what the framework cannot know.

// The suite's one preload, named in `bunfig.toml`:
//
//   [test]
//   preload = ["./scripts/test-setup.ts"]
//
// The framework is imported by relative path rather than by `@ultimat3/*`: this directory is not
// a workspace member yet (issue #9), and a preload runs before anything else, so it must not
// depend on workspace symlinks. A generated app writes `@ultimat3/testing` here. For the same
// reason `scripts/` is not in tsconfig's `include` — a composite project cannot reach across
// into another one's sources. Both go away when the app joins the workspace.
import '../../../packages/testing/src/preload';
// The registration pass, and it belongs HERE rather than in a test file: importing the API stamps
// each export name onto its declaration, which is what gives a projection a stable name to project
// under. A test in `app/` that imported it would be `app/` reaching into `api/` at runtime — the
// boundary `x verify` rejects with `X_BOUNDARY_VIOLATION`, because it is the edge along which a
// page could call a handler instead of the typed client. The preload is outside both, runs once
// for the whole suite, and is already where the app says what its tests need. Same relative-path
// convention, same reason.
import '../apps/web/api';
import { assert, userActor } from '../../../packages/core/src/index';
import type { Driver, EntityCore, Repo, Seed } from '../../../packages/entity/src/index';
import { memoryDriver, seedId } from '../../../packages/entity/src/index';
import { defineFixtures } from '../../../packages/testing/src/index';

/** Every seeded row carries an id; the rest of the columns are the entity's business. */
export interface SeedRow {
  readonly id: string;
  readonly [column: string]: unknown;
}

export interface SeedHandle {
  /** `pick({ draft: 'post:draft-money' })` — seed labels in, rows out, aliased at the call site. */
  pick<M extends Readonly<Record<string, string>>>(
    labels: M,
  ): Promise<{ readonly [K in keyof M]: SeedRow }>;
}

const idOf = (row: unknown): string | undefined => {
  const value = (row as { readonly id?: unknown }).id;
  return typeof value === 'string' ? value : undefined;
};

/**
 * Rows are captured on the way in rather than read back out: a tenant-scoped entity refuses an
 * unscoped read, so a fixture would have to name the org before it could fetch the org. Insert
 * still runs `$parse` and the invariants, so seeding still tests the schema.
 */
const capturingDriver = (rows: Map<string, SeedRow>): Driver => {
  const base = memoryDriver();
  return {
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const inner = base.repo(entity);
      return {
        ...inner,
        insert: async (values, options) => {
          const row = await inner.insert(values, options);
          const id = idOf(row);
          if (id !== undefined) rows.set(id, row as SeedRow);
          return row;
        },
      };
    },
  };
};

/** A fresh graph per call: two tests must never see each other's writes. */
const handleFor = (seed: Seed): SeedHandle => {
  const rows = new Map<string, SeedRow>();
  const ready = seed.run({ driver: capturingDriver(rows) });

  return {
    pick: async <M extends Readonly<Record<string, string>>>(labels: M) => {
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
      return picked as { readonly [K in keyof M]: SeedRow };
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

/** A member row is the actor: same org, and its membership role is the authz role. */
const actorFor = (member: SeedRow) =>
  userActor({
    id: String(member['userId'] ?? member.id),
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  });

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
