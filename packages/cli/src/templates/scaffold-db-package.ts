// The generated app's `packages/db`: the entity re-export list the migration generator reads, the
// deterministic seed, and the initial migration. No business logic — that is the package's own
// stated boundary, and it is why `example` reaches only the three files describing the slice's
// table.

import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const DESCRIPTION = 'Entity re-exports and SQL migrations, no business logic';

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

const SCHEMA_HEADER = `// Every entity the app declares, re-exported here. This list is what the migration generator
// reads, so an entity that is not exported here does not exist as far as the database is concerned.`;

/**
 * `bun run db:seed`'s entry point. Identical either way — only the rows differ. Interpolated, not
 * nested, so it carries exactly the escaping a single template literal needs.
 */
const SEED_MAIN = `

if (import.meta.main) {
  const count = await seed();
  // Bun's stdout, not process.stdout: one runtime, one API. Awaited because the write resolves
  // asynchronously, and this JSON line is the whole output of \`bun run db:seed\`.
  await Bun.stdout.write(\`\${JSON.stringify({ ok: true, seeded: count })}\\n\`);
}
`;

const dbSchema = (app: NameSet, example: boolean): string =>
  example
    ? `${SCHEMA_HEADER}
export { post } from '@${app.kebab}/web/app/post/entity';
`
    : `${SCHEMA_HEADER}
// \`x g entity <name>\` writes the entity; add its export here so the database learns about it.
export {};
`;

const dbSeed = (app: NameSet, example: boolean): string =>
  example
    ? `// Deterministic seed: same rows every time, so a test and a demo see the same database.
import { db, sql } from '@ultimat3/db';

const ORG = '00000000-0000-0000-0000-000000000002';

export async function seed(): Promise<number> {
  const rows = [
    { id: '00000000-0000-0000-0000-000000000101', title: 'Hello ${app.pascal}', minor: 0 },
    { id: '00000000-0000-0000-0000-000000000102', title: 'Second post', minor: 1900 },
  ];
  for (const row of rows) {
    // Idempotent by primary key, so re-seeding a branch database is a no-op rather than a crash.
    await db().execute(sql\`
      insert into posts (id, org_id, title, price_minor, price_currency)
      values (\${row.id}, \${ORG}, \${row.title}, \${row.minor}, 'USD')
      on conflict (id) do nothing\`);
  }
  return rows.length;
}${SEED_MAIN}`
    : `// Deterministic seed: same rows every time, so a test and a demo see the same database.
// No entity is declared yet, so there is nothing to insert — the shape stays, so the first
// \`x g entity\` has one obvious place to seed from.

export async function seed(): Promise<number> {
  return 0;
}${SEED_MAIN}`;

const migration = (example: boolean): string =>
  example
    ? `-- 0000_initial: the example feature slice. Reversible: the down section is required.
CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  price_minor integer NOT NULL DEFAULT 0,
  price_currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_org_created_idx ON posts (org_id, created_at);

-- down
-- DROP INDEX IF EXISTS posts_org_created_idx;
-- DROP TABLE IF EXISTS posts;
`
    : `-- 0000_initial: no entity is declared yet, so this migration creates nothing. It exists so the
-- schema hash beside it has a migration to belong to, and \`x verify\` sees no drift on run one.
-- Reversible: the down section is required.

-- down
`;

/** Every file the `packages/db` workspace ships, in the order `x new` writes them. */
export const dbPackageFiles = (app: NameSet, example: boolean): readonly GeneratedFile[] => [
  { path: 'packages/db/package.json', contents: workspacePackageJson(app, 'db', DESCRIPTION) },
  ...packageShapeFiles(app, 'db', DESCRIPTION),
  { path: 'packages/db/src/index.ts', contents: dbIndex() },
  { path: 'packages/db/src/schema.ts', contents: dbSchema(app, example) },
  { path: 'packages/db/src/seed.ts', contents: dbSeed(app, example) },
  { path: 'packages/db/migrations/0000_initial.sql', contents: migration(example) },
];
