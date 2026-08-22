// The generated app's `packages/db`: the entity re-export list the app's own modules import from
// and the deterministic seed. No business logic — that is the package's own stated boundary, and it
// is why `example` reaches only the two files describing the slice's table.
//
// No migration. `x db gen` is the ONE writer of `packages/db/migrations`, and a scaffold that hand-
// wrote `0000_initial.sql` was a second one: it declared a `posts` table the generator had never
// diffed, so the first `x db gen` saw a schema the ledger already claimed and the two disagreed
// about what "initial" meant. `x db gen "initial"` is the app's first command instead — it writes
// the `.sql`, the `.snapshot.json` and the `.hash` together, which no hand-written file can.

import type { GeneratedFile, NameSet } from './naming';
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
  (): string => `// Schema and migrations only — no business logic lives in this package. The client itself is
// @ultimat3/db's: one connection pool, sized by ROLE, shared by every package in the app.
export type { DbClient, SqlFragment } from '@ultimat3/db';
export { db, sql, withTransaction } from '@ultimat3/db';
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
import { defineSeed } from '@ultimat3/entity';
import { post } from './schema';

/** Stable across runs: \`id('post:hello')\` is a UUID v5 of the label, not a random one. */
export const ${app.camel}Seed = defineSeed('${app.kebab}', async ({ insert, id }) => {
  await insert(post, [
    {
      id: id('post:hello'),
      orgId: id('org:demo'),
      title: 'Hello ${app.pascal}',
      price: { minor: 0, currency: 'USD' },
    },
    {
      id: id('post:second'),
      orgId: id('org:demo'),
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

/** Every file the `packages/db` workspace ships, in the order `x new` writes them. */
export const dbPackageFiles = (app: NameSet, example: boolean): readonly GeneratedFile[] => [
  { path: 'packages/db/package.json', contents: dbPackage(app, example) },
  ...packageShapeFiles(app, 'db', DESCRIPTION),
  { path: 'packages/db/src/index.ts', contents: dbIndex() },
  { path: 'packages/db/src/schema.ts', contents: dbSchema(app, example) },
  { path: 'packages/db/src/seed.ts', contents: dbSeed(app, example) },
];
