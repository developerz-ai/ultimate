// The generated app's `packages/db`: the entity re-export list the app's own modules import from
// and the deterministic seed. No business logic — that is the package's own stated boundary, and it
// is why `example` reaches only the two files describing the slice's table.
//
// No migration and no schema dump. `x db gen` is the ONE writer of `packages/db/migrations` and
// of `packages/db/schema`, and a scaffold that hand-wrote `0000_initial.sql` was a second one: it
// declared a `posts` table the generator had never diffed, so the first `x db gen` saw a schema
// the ledger already claimed and the two disagreed about what "initial" meant. `x db gen
// "initial"` is the app's first command instead — it writes the `.sql`, the `.snapshot.json`, the
// `.hash` and the dump together, which no hand-written file can.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { dbClientFiles } from './scaffold-db-client';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = 'Entity re-exports and SQL migrations, no business logic';

/**
 * The example slice's entity lives in `apps/web/app/post/`, so `src/schema.ts` re-exports it from
 * there — an edge this manifest has to declare or it exists only inside the root tsconfig's
 * `paths`, where `bun --filter` and every change-detection tool are blind to it
 * (`X_WORKSPACE_DEP_UNDECLARED`). Written here rather than through `workspacePackageJson` for the
 * reason `scaffold-i18n.ts` states: that helper is the dependency-free shape.
 *
 * Under `--no-example` there is no entity and no import, so there is no dependency either: a pin
 * for an edge the package does not have is the same lie in the other direction.
 */
const dbPackage = (app: NameSet, example: boolean): string =>
  example
    ? `{
  "name": "@${app.kebab}/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "${DESCRIPTION}",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  },
  "dependencies": {
    "@${app.kebab}/web": "0.0.0"
  }
}
`
    : workspacePackageJson(app, 'db', DESCRIPTION);

const dbIndex =
  (): string => `// Schema, migrations and the typed handle — no business logic lives in this package.
// \`db\` is the handle \`./client\` builds over the app's entities: \`db.<table>\`, which is what a
// feature's repo.ts reads through. \`sql\` and \`withTransaction\` are @ultimat3/db's own, and the
// connection pool behind all three is one, sized by ROLE.
export type { DbClient, SqlFragment } from '@ultimat3/db';
export { sql, withTransaction } from '@ultimat3/db';
export type { Db } from './client';
export { db, driver, selectDriver } from './client';
export * as schema from './schema';
`;

// The four pieces below describe the example slice's table. Under `--no-example` that slice is
// never written, so each one ships its empty counterpart instead of a reference to a file that is
// not there — `export { post } from …` alone made `x new --no-example` an app that cannot compile.

// Not "what the migration generator reads" — that claim shipped into every generated app and was
// false. `x db gen` and `x verify`'s `drift` step both project the ENTITY REGISTRY that `loadApp`
// fills (`describeEntities()`, `packages/cli/src/app-entities.ts`), so an entity declared anywhere
// `loadApp` reaches is already in the migration whether or not this file names it. Re-exporting an
// entity here does exactly one thing, and it is worth doing: it gives `seed.ts` and every other
// consumer ONE import to reach the app's tables through.
const SCHEMA_HEADER = `// Every entity the app declares, re-exported here so the seed and anything else that needs a table
// reach them through one import. It is not what the migration generator reads: \`x db gen\` and the
// \`drift\` step project the entity registry, so an entity is in the migration because it was
// declared, never because it was listed here.`;

const dbSchema = (app: NameSet, example: boolean): string =>
  example
    ? `${SCHEMA_HEADER}
export { post } from '@${app.kebab}/web/app/post/entity';
`
    : `${SCHEMA_HEADER}
// \`x g entity <name>\` writes the entity; add its export here to reach it through \`@${app.kebab}/db\`.
export {};
`;

/**
 * The seed, as a `defineSeed()` — which is what `x db seed` discovers and what the framework has
 * meant by "a seed" since 2.0.0.
 *
 * It used to be a plain `export async function seed()` with an `import.meta.main` block, run by a
 * `bun run db:seed` npm script, and that shipped two defects at once. `x db seed` discovers
 * every `seed*.ts` under a package's `src` and looks for an exported `Seed`, so the scaffold's
 * own seed was invisible to its own command — `x db seed` on a fresh app answered "no seed
 * matched".
 * And `bun run db:seed` reaches the database through `@ultimat3/db`'s `db()`, which reads
 * `DATABASE_URL` and speaks `postgres:` only, so on a clone with no Postgres it cannot see the
 * embedded PGlite that `x db migrate` had just migrated in process. `bin/setup` therefore printed
 * `✓ migrations applied` and then died on `X_DB_UNAVAILABLE`, whose `fix:` says "run `x dev` to use
 * the embedded PGlite" — naming the mechanism that had just worked one line above.
 *
 * `x db seed` owns the connection, the tier and the per-seed transaction. One runner, one answer.
 */
/**
 * The seed's two package imports in the order Biome sorts them: the app's own scope can sort on
 * either side of \`@ultimat3\`, and a fixed order is a lint failure for half of all app names.
 */
const seedImports = (app: NameSet): string =>
  [
    [`@${app.kebab}/web/shared/demo-org`, 'DEMO_ORG_LABEL'],
    ['@ultimat3/entity', 'defineSeed'],
  ]
    .sort(([a = ''], [b = '']) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([from, name]) => `import { ${name} } from '${from}';`)
    .join('\n');

const dbSeed = (app: NameSet, example: boolean): string =>
  example
    ? `// Deterministic fixtures: the same rows every time, so a test, a demo and a branch database
// all see the same content.
//
// \`x db seed\` is the runner — it discovers every exported \`defineSeed()\` in a package's
// \`src/seed*.ts\`, opens the database exactly as \`x db migrate\` does (embedded PGlite
// included), and wraps each seed in its own transaction. Never a plain \`bun run\` script: that
// reaches the database through \`db()\`, which needs a \`postgres:\` \`DATABASE_URL\` and so cannot
// see the embedded database at all.
${seedImports(app)}
import { post } from './schema';

/** Stable across runs: \`id('post:hello')\` is a UUID v5 of the label, not a random one. */
export const ${app.camel}Seed = defineSeed('${app.kebab}', async ({ insert, id }) => {
  await insert(post, [
    {
      id: id('post:hello'),
      orgId: id(DEMO_ORG_LABEL),
      title: 'Hello ${app.pascal}',
      price: { minor: 0, currency: 'USD' },
    },
    {
      id: id('post:second'),
      orgId: id(DEMO_ORG_LABEL),
      title: 'Second post',
      price: { minor: 1900, currency: 'USD' },
    },
  ]);
});
`
    : `// Deterministic fixtures, run by \`x db seed\`. No entity is declared yet, so there is nothing
// to insert — the shape stays so the first \`x g entity\` has one obvious place to seed from.
//
// \`x db seed\` discovers every exported \`defineSeed()\` in a package's \`src/seed*.ts\` and opens
// the database the way \`x db migrate\` does, embedded PGlite included. Never a plain \`bun run\`
// script: that needs a \`postgres:\` \`DATABASE_URL\` and cannot see the embedded database.
import { defineSeed } from '@ultimat3/entity';

export const ${app.camel}Seed = defineSeed('${app.kebab}', async () => {
  // \`await insert(<entity>, [...])\` once an entity exists.
});
`;

const dbSeedTest = (app: NameSet, example: boolean): string =>
  example
    ? `// The seed, run against the in-memory driver: the rows it writes, whose they are, and that a
// second run writes nothing. The org is the point — a row seeded under any other id is one the
// development viewer's tenant policy refuses, and the dashboard then counts zero.
${sortedImports([
  `import { DEMO_ORG_ID } from '@${app.kebab}/web/shared/demo-org';`,
  "import { createContext, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { afterEach, expect, unitTest } from '@ultimat3/testing';",
])}
import { db, driver } from './client';
import { ${app.camel}Seed } from './seed';

/** The development viewer's org: every read below runs as an actor inside it. */
const asViewer = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: testActor('viewer', { orgId: DEMO_ORG_ID }).actor }), run);

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('the seed writes its posts under the demo org', async () => {
  const run = await ${app.camel}Seed.run({ driver });
  expect(run.metrics).toEqual({ inserted: 2, updated: 0, skipped: 0 });
  const rows = await asViewer(() => db.posts.where({ orgId: DEMO_ORG_ID }).orderBy('title').all());
  expect(rows.map((row) => row.title)).toEqual(['Hello ${app.pascal}', 'Second post']);
  expect(rows.map((row) => row.price.minor)).toEqual([0, 1900]);
});

unitTest('a replay writes nothing: its ids are derived from labels, never generated', async () => {
  await ${app.camel}Seed.run({ driver });
  const replay = await ${app.camel}Seed.run({ driver });
  expect(replay.metrics).toEqual({ inserted: 0, updated: 0, skipped: 2 });
});
`
    : `// The seed as \`x db seed\` finds it: a declared \`defineSeed()\` under this app's name, which
// writes nothing until an entity exists. The day it inserts a row, the last assertion says so.
import { isSeed } from '@ultimat3/entity';
import { expect, unitTest } from '@ultimat3/testing';
import { driver } from './client';
import { ${app.camel}Seed } from './seed';

unitTest('the seed is one x db seed discovers, in the dev tier', () => {
  expect(isSeed(${app.camel}Seed)).toBe(true);
  expect(${app.camel}Seed.name).toBe('${app.kebab}');
  // \`dev\`: fixture data, never loaded into production. \`reference\` is the other tier.
  expect(${app.camel}Seed.tier).toBe('dev');
});

unitTest('it writes nothing yet', async () => {
  const run = await ${app.camel}Seed.run({ driver });
  expect(run.metrics).toEqual({ inserted: 0, updated: 0, skipped: 0 });
});
`;

/**
 * `packages/db/schema/` is written by `x db gen` and held by the `drift` step, so two things about
 * it are git's to know. `linguist-generated` collapses it in a review — the migration is what a
 * human reads; the dump is its projection. `text eol=lf` is not cosmetic: the gate compares bytes,
 * and a checkout that rewrote line endings would be `X_SCHEMA_DUMP_DRIFT` on a correct tree.
 *
 * The attributes ship; the directory does not. `x new` scaffolds no migration, so there is nothing
 * to dump until the first `x db gen` — which creates it.
 */
export const DB_GITATTRIBUTES = `# Generated by \`x db gen\` from the migrations and held equal to them by \`x verify\`'s drift
# step (X_SCHEMA_DUMP_DRIFT). Review the migration, not this projection of it.
schema/** linguist-generated=true text eol=lf
`;

/** Every file the `packages/db` workspace ships, in the order `x new` writes them. */
export const dbPackageFiles = (app: NameSet, example: boolean): readonly GeneratedFile[] => [
  { path: 'packages/db/package.json', contents: dbPackage(app, example) },
  { path: 'packages/db/.gitattributes', contents: DB_GITATTRIBUTES },
  ...packageShapeFiles(app, 'db', DESCRIPTION),
  { path: 'packages/db/src/index.ts', contents: dbIndex() },
  // The typed handle and its test — `scaffold-db-client.ts`, shared with `x g entity`.
  ...dbClientFiles(app, example),
  { path: 'packages/db/src/schema.ts', contents: dbSchema(app, example) },
  { path: 'packages/db/src/seed.ts', contents: dbSeed(app, example) },
  { path: 'packages/db/src/seed.test.ts', contents: dbSeedTest(app, example) },
];
