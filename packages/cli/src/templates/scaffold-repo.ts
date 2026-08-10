// The config half of what `x new` writes: the one config file, the tooling configs and the
// workspace packages. Committed defaults only — a fresh clone boots with `x dev` and no env
// scavenger hunt. The docs, shims and container files live in scaffold-docs.ts.

import type { GeneratedFile, NameSet } from './naming';
import { docsFiles } from './scaffold-docs';

const rootPackage = (app: NameSet, version: string): string => `{
  "name": "${app.kebab}",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "setup": "bin/setup",
    "dev": "x dev",
    "check": "bin/check",
    "verify": "x verify",
    "typecheck": "tsc -b --pretty",
    "lint": "biome check .",
    "test": "bun test",
    "db:migrate": "x db migrate",
    "db:seed": "bun run packages/db/src/seed.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.15",
    "@electric-sql/pglite": "^0.5.4",
    "@types/bun": "^1.3.14",
    "@ultimat3/testing": "^${version}",
    "typescript": "^6.0.3"
  },
  "dependencies": {
    "@ultimat3/action": "^${version}",
    "@ultimat3/cache": "^${version}",
    "@ultimat3/cli": "^${version}",
    "@ultimat3/core": "^${version}",
    "@ultimat3/db": "^${version}",
    "@ultimat3/entity": "^${version}",
    "@ultimat3/i18n": "^${version}",
    "@ultimat3/jobs": "^${version}",
    "@ultimat3/mcp": "^${version}",
    "@ultimat3/policy": "^${version}",
    "@ultimat3/pwa": "^${version}",
    "@ultimat3/query": "^${version}",
    "@ultimat3/render": "^${version}",
    "@ultimat3/ui": "^${version}",
    "solid-js": "^2.0.0"
  },
  "engines": {
    "bun": ">=1.3.0"
  }
}
`;

const rootTsconfig = (app: NameSet): string => `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "paths": {
      "@${app.kebab}/*": ["./packages/*/src"]
    },
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve",
    "jsxImportSource": "solid-js"
  },
  "exclude": ["node_modules", "dist", ".x"]
}
`;

const appConfig = (
  app: NameSet,
): string => `// The one config file. Everything the app needs to boot is here, typed and validated at startup —
// a missing value fails the boot with the exact command that fixes it, never at the first request.
// A named export, never a default: the CLI and the runtime both import \`config\` by name.
import { defineConfig } from '@ultimat3/core';

export const config = defineConfig({
  name: '${app.kebab}',
  locales: ['en'],
  defaultLocale: 'en',
  defaultTimeZone: 'UTC',
  defaultCurrency: 'USD',
  // Env KEYS, never the value: the same image deploys to every environment.
  database: { urlEnv: 'DATABASE_URL', poolSize: 10 },
  cache: { driver: 'memory', tiers: ['memo', 'lru'] },
  jobs: { driver: 'postgres', queues: ['${app.kebab}-default'], concurrency: 4 },
  // In-process transport by default; set urlEnv and transport: 'nats' to scale past one node.
  realtime: { enabled: true, tier: 'live-queries', transport: 'memory' },
  pwa: { enabled: true, offline: 'runtime', installPrompt: true },
  ai: { mcp: { expose: true, path: '/mcp' } },
});
`;

const biome = (): string => `{
  "$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "correctness": { "noUnusedVariables": "error", "noUnusedImports": "error" }
    }
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  }
}
`;

const bunfig = (): string => `[test]
root = "."
# Frozen clock, seeded RNG, sealed network — nondeterminism in a test is a bug.
preload = ["@ultimat3/testing/preload"]
`;

const scssTypes =
  (): string => `// SCSS modules resolve to a class-name map at build time. Ambient because an import cannot
// reach a declaration file — every surface names this file in its tsconfig "include".

declare module '*.module.scss' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
`;

const gitignore = (): string => `node_modules/
.x/
dist/
*.tsbuildinfo
.env
.env.*.local
coverage/
playwright-report/
test-results/
`;

const envDevelopment =
  (): string => `# Committed non-secret defaults. Per-box secrets go in .env.development.local, which wins.
# Empty DATABASE_URL means "embedded": x dev runs PGlite in-process, no Docker required.
DATABASE_URL=
NATS_URL=
S3_ENDPOINT=
PORT=3000
ROLE=web
`;

const domainPackage = (app: NameSet, name: string, description: string): string => `{
  "name": "@${app.kebab}/${name}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "${description}",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  }
}
`;

const domainIndex =
  (): string => `// Pure types and constants. No I/O of any kind: no fs, no network, no database, no env reads.
export const ROLES = ['owner', 'member', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export interface Money {
  readonly minor: number;
  readonly currency: string;
}

export const zero = (currency: string): Money => ({ minor: 0, currency });

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new RangeError(\`cannot add \${a.currency} to \${b.currency}\`);
  return { minor: a.minor + b.minor, currency: a.currency };
};
`;

const domainTest = (): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { add, zero } from './index';

unitTest('money adds in minor units', () => {
  expect(add({ minor: 1050, currency: 'USD' }, { minor: 250, currency: 'USD' })).toEqual({
    minor: 1300,
    currency: 'USD',
  });
});

unitTest('money refuses to add across currencies', () => {
  expect(() => add(zero('USD'), zero('EUR'))).toThrow();
});
`;

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

const i18nIndex =
  (): string => `// Flat catalog, loud misses. A missing key renders ⟦key⟧ in dev and fails x verify in CI.
// Every JSON file under catalogs/<locale>/ is merged, so \`x g route\` can add a file without
// anyone remembering to also edit an index — the distant invariant this package exists to avoid.
import { readdirSync, readFileSync } from 'node:fs';

const load = (locale: string): Readonly<Record<string, string>> => {
  const dir = new URL(\`../catalogs/\${locale}/\`, import.meta.url).pathname;
  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => Object.entries(JSON.parse(readFileSync(dir + file, 'utf8'))));
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
};

export const catalogs = { en: load('en') } as const;

export type Locale = keyof typeof catalogs;

export const keys: readonly string[] = Object.keys(catalogs.en);
`;

// `app.post.*` is deliberately absent: the example slice ships its own `post.json`, and a key in
// both files is one key shadowing another — and a dangling one under `--no-example`.
const i18nCatalog = (app: NameSet): string => `{
  "site.home.title": "${app.pascal}",
  "site.home.description": "Everything you need, one command from shippable.",
  "site.home.cta": "Open the dashboard",
  "app.dashboard.title": "Dashboard",
  "app.dashboard.description": "Your workspace.",
  "app.offline.title": "You are offline",
  "app.offline.description": "This page will refresh itself when the connection returns.",
  "admin.home.title": "Admin",
  "admin.home.description": "Operations for ${app.pascal}."
}
`;

const i18nTest = (): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { catalogs, keys } from './index';

unitTest('every catalog has the same keys as en', () => {
  for (const catalog of Object.values(catalogs)) {
    expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
  }
});

unitTest('no catalog value is empty', () => {
  for (const value of Object.values(catalogs.en)) expect(String(value).length).toBeGreaterThan(0);
});
`;

const uiIndex =
  (): string => `// App components on top of @ultimat3/ui. Same byte budgets as shared/: this package is imported
// by site/, so a chart library in here costs the landing page.
export { Card } from './card';
`;

const uiCard = (): string => `import type { JSX } from 'solid-js';
import styles from './card.module.scss';

export interface CardProps {
  readonly title: string;
  readonly children?: JSX.Element;
}

export function Card(props: CardProps) {
  return (
    <section class={styles.card}>
      <h2 class={styles.title}>{props.title}</h2>
      {props.children}
    </section>
  );
}
`;

const uiCardStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.card {
  padding: tokens.$space-4;
  border-radius: tokens.$radius-md;
  background: tokens.$surface-raised;
  color: tokens.$text-primary;
}

.title {
  font: tokens.$text-heading-sm;
}
`;

const mcpIndex = (
  app: NameSet,
): string => `// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
import * as api from '@${app.kebab}/web/api/health';
import { registerActions } from '@ultimat3/action';
import { defineAppMcp } from '@ultimat3/mcp';

// Names come from export names, so the registry agrees with the module the app already wrote.
registerActions(api);

// \`include: 'exposed'\` projects straight from the registry. Re-listing the actions here would
// copy \`mcp: { expose: true }\` into a second place, and the copy goes stale in silence.
export const mcp = defineAppMcp({
  name: '${app.kebab}',
  include: 'exposed',
});
`;

const mcpTest = (): string => `import { expect, unitTest } from '@ultimat3/testing';
import { mcp } from './index';

unitTest('the app exposes its actions as MCP tools', () => {
  expect(mcp.tools.length).toBeGreaterThan(0);
  // Every projected tool must describe itself: an agent picks a tool by its description. Assert
  // on the value, not its length — a failure then prints the empty description, not "0 > 0".
  for (const tool of mcp.tools) expect(tool.description).not.toBe('');
});
`;

/**
 * `example` reaches only the four files that describe the slice's table — schema, seed, initial
 * migration, and nothing in the catalog. Everything else is the same app either way, which is what
 * `--no-example` promises: the same shape with an empty `app/`.
 */
export function repoFiles(
  app: NameSet,
  version: string,
  example: boolean,
): readonly GeneratedFile[] {
  return [
    ...docsFiles(app),
    { path: 'package.json', contents: rootPackage(app, version) },
    { path: 'tsconfig.json', contents: rootTsconfig(app) },
    { path: 'biome.json', contents: biome() },
    { path: 'bunfig.toml', contents: bunfig() },
    { path: 'app.config.ts', contents: appConfig(app) },
    { path: 'types/scss.d.ts', contents: scssTypes() },
    { path: '.gitignore', contents: gitignore() },
    { path: '.env.development', contents: envDevelopment() },
    {
      path: 'packages/domain/package.json',
      contents: domainPackage(app, 'domain', 'Pure types and constants, no I/O'),
    },
    { path: 'packages/domain/src/index.ts', contents: domainIndex() },
    { path: 'packages/domain/src/index.test.ts', contents: domainTest() },
    {
      path: 'packages/db/package.json',
      contents: domainPackage(app, 'db', 'Entity re-exports and SQL migrations, no business logic'),
    },
    { path: 'packages/db/src/index.ts', contents: dbIndex() },
    { path: 'packages/db/src/schema.ts', contents: dbSchema(app, example) },
    { path: 'packages/db/src/seed.ts', contents: dbSeed(app, example) },
    { path: 'packages/db/migrations/0000_initial.sql', contents: migration(example) },
    {
      path: 'packages/i18n/package.json',
      contents: domainPackage(app, 'i18n', 'Flat catalogs with loud misses'),
    },
    { path: 'packages/i18n/src/index.ts', contents: i18nIndex() },
    { path: 'packages/i18n/src/index.test.ts', contents: i18nTest() },
    { path: 'packages/i18n/catalogs/en/app.json', contents: i18nCatalog(app) },
    {
      path: 'packages/ui/package.json',
      contents: domainPackage(app, 'ui', 'App components on @ultimat3/ui'),
    },
    { path: 'packages/ui/src/index.ts', contents: uiIndex() },
    { path: 'packages/ui/src/card.tsx', contents: uiCard() },
    { path: 'packages/ui/src/card.module.scss', contents: uiCardStyle() },
    {
      path: 'packages/mcp/package.json',
      contents: domainPackage(app, 'mcp', "The app's own MCP tools"),
    },
    { path: 'packages/mcp/src/index.ts', contents: mcpIndex(app) },
    { path: 'packages/mcp/src/index.test.ts', contents: mcpTest() },
  ];
}
