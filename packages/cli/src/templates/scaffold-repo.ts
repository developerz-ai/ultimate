// The config half of what `x new` writes: the one config file, the tooling configs and the
// workspace packages. Committed defaults only — a fresh clone boots with `x dev` and no env
// scavenger hunt. The docs, shims and container files live in scaffold-docs.ts.

import type { GeneratedFile, NameSet } from './naming';
import { docsFiles } from './scaffold-docs';

const rootPackage = (app: NameSet): string => `{
  "name": "${app.kebab}",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
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
    "@types/bun": "^1.3.14",
    "@ultimat3/testing": "^0.0.1",
    "typescript": "^6.0.3"
  },
  "dependencies": {
    "@ultimat3/action": "^0.0.1",
    "@ultimat3/cli": "^0.0.1",
    "@ultimat3/core": "^0.0.1",
    "@ultimat3/db": "^0.0.1",
    "@ultimat3/entity": "^0.0.1",
    "@ultimat3/i18n": "^0.0.1",
    "@ultimat3/jobs": "^0.0.1",
    "@ultimat3/mcp": "^0.0.1",
    "@ultimat3/policy": "^0.0.1",
    "@ultimat3/pwa": "^0.0.1",
    "@ultimat3/query": "^0.0.1",
    "@ultimat3/render": "^0.0.1",
    "@ultimat3/ui": "^0.0.1",
    "drizzle-orm": "^0.44.0",
    "solid-js": "^2.0.0"
  },
  "engines": { "bun": ">=1.3.0" }
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
import { defineApp } from '@ultimat3/core';

export default defineApp({
  name: '${app.kebab}',
  locales: { default: 'en', supported: ['en'] },
  timeZone: 'UTC',
  currency: 'USD',
  db: { url: process.env['DATABASE_URL'] ?? 'embedded' },
  auth: { providers: ['password'], sessionDays: 30 },
  jobs: { driver: 'postgres', queues: { default: { concurrency: 4 } } },
  realtime: { transport: process.env['NATS_URL'] === undefined ? 'in-process' : 'nats' },
  storage: { driver: process.env['S3_ENDPOINT'] === undefined ? 'local-dir' : 's3' },
  budgets: { site: { js: '0kb' }, app: { js: '60kb' } },
  observability: { otel: true, serviceName: '${app.kebab}' },
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
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit -p ../../tsconfig.json" }
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

const dbIndex = (
  app: NameSet,
): string => `// The Drizzle client. Schema and migrations only — no business logic lives in this package.
export { db } from './client';
export * as schema from './schema';
export type { ${app.pascal}Database } from './client';
`;

const dbClient = (
  app: NameSet,
): string => `// One database handle per process. The URL comes from app.config.ts, which validated it at boot.
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import * as schema from './schema';

const url = process.env['DATABASE_URL'];

export const db = drizzle(new SQL(url === undefined || url === '' ? 'postgres://localhost/${app.kebab}' : url), {
  schema,
});

export type ${app.pascal}Database = typeof db;
`;

const dbSchema = (
  app: NameSet,
): string => `// Every entity the app declares, re-exported here. This list is what the migration generator
// reads, so an entity that is not exported here does not exist as far as the database is concerned.
export { post } from '@${app.kebab}/web/app/post/entity';
`;

const dbSeed = (
  app: NameSet,
): string => `// Deterministic seed: same rows every time, so a test and a demo see the same database.
import { db } from './client';
import { post } from './schema';

const ORG = '00000000-0000-0000-0000-000000000002';

export async function seed(): Promise<number> {
  const rows = [
    { id: '00000000-0000-0000-0000-000000000101', orgId: ORG, title: 'Hello ${app.pascal}', priceMinor: 0, priceCurrency: 'USD' },
    { id: '00000000-0000-0000-0000-000000000102', orgId: ORG, title: 'Second post', priceMinor: 1900, priceCurrency: 'USD' },
  ];
  await db.insert(post).values(rows).onConflictDoNothing();
  return rows.length;
}

if (import.meta.main) {
  const count = await seed();
  process.stdout.write(JSON.stringify({ ok: true, seeded: count }) + '\\n');
}
`;

const migration =
  (): string => `-- 0000_initial: the example feature slice. Reversible: the down section is required.
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

const i18nCatalog = (app: NameSet): string => `{
  "site.home.title": "${app.pascal}",
  "site.home.description": "Everything you need, one command from shippable.",
  "site.home.cta": "Open the dashboard",
  "app.dashboard.title": "Dashboard",
  "app.dashboard.description": "Your workspace.",
  "app.offline.title": "You are offline",
  "app.offline.description": "This page will refresh itself when the connection returns.",
  "app.post.empty": "No posts yet.",
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
import { defineTools } from '@ultimat3/mcp';
import { health } from '@${app.kebab}/web/api/health';

export const tools = defineTools({
  name: '${app.kebab}',
  actions: [health],
});
`;

const mcpTest = (app: NameSet): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { tools } from './index';

unitTest('the app exposes its actions as MCP tools', () => {
  expect(tools.name).toBe('${app.kebab}');
  expect(tools.actions.length).toBeGreaterThan(0);
});
`;

export function repoFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    ...docsFiles(app),
    { path: 'package.json', contents: rootPackage(app) },
    { path: 'tsconfig.json', contents: rootTsconfig(app) },
    { path: 'biome.json', contents: biome() },
    { path: 'bunfig.toml', contents: bunfig() },
    { path: 'app.config.ts', contents: appConfig(app) },
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
      contents: domainPackage(app, 'db', 'Drizzle schema and migrations, no business logic'),
    },
    { path: 'packages/db/src/index.ts', contents: dbIndex(app) },
    { path: 'packages/db/src/client.ts', contents: dbClient(app) },
    { path: 'packages/db/src/schema.ts', contents: dbSchema(app) },
    { path: 'packages/db/src/seed.ts', contents: dbSeed(app) },
    { path: 'packages/db/migrations/0000_initial.sql', contents: migration() },
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
    { path: 'packages/mcp/src/index.test.ts', contents: mcpTest(app) },
  ];
}
