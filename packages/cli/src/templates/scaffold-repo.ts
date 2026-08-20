// The REPO ROOT half of what `x new` writes: `app.config.ts`, the tooling configs, the committed
// env files — and the one list that names every other scaffold module in write order. Committed
// defaults only, so a fresh clone boots with `x dev` and no env scavenger hunt. Each workspace
// package owns its own files (`scaffold-<name>-package.ts`); docs and shims are scaffold-docs.ts,
// container files scaffold-container.ts.

import { ENV_EXAMPLE_PATH } from '@ultimat3/core';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import type { VerifyStepName } from '../verify-step';
import type { GeneratedFile, NameSet } from './naming';
import { dbPackageFiles } from './scaffold-db-package';
import { docsFiles } from './scaffold-docs';
import { domainPackageFiles } from './scaffold-domain-package';
import { envExampleSource, envSchemaSource } from './scaffold-env';
import { i18nFiles } from './scaffold-i18n';
import { mcpPackageFiles } from './scaffold-mcp-package';
import { uiPackageFiles } from './scaffold-ui-package';

/**
 * Spelled once and pinned EXACTLY, because two places named it and a caret let them disagree:
 * `"^2.4.15"` beside a `$schema` of `2.4.15` installed 2.5.8, whose own parser then reported the
 * config as out of date on every `bun run lint`. A formatter is a build input — a range that floats
 * is a `lint` step whose verdict depends on the day the app was installed.
 */
const BIOME_VERSION = '2.5.8';

// `version` is not decoration: the manifest's app version IS the contract's compatibility gate,
// and the manifest never fabricates one — so an app scaffolded without it failed `x manifest`,
// the `manifest` verify step and every production boot with X_APP_PACKAGE_INVALID.
const rootPackage = (app: NameSet, version: string): string => `{
  "name": "${app.kebab}",
  "version": "0.1.0",
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
    "@biomejs/biome": "${BIOME_VERSION}",
    "@electric-sql/pglite": "^0.5.4",
    "@types/bun": "^1.3.14",
    "@ultimat3/testing": "^${version}",
    "typescript": "^6.0.3"
  },
  "dependencies": {
    "@ultimat3/action": "^${version}",
    "@ultimat3/admin": "^${version}",
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
    "@ultimat3/schema": "^${version}",
    "@ultimat3/ui": "^${version}",
    "solid-js": "1.9.14"
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
      "@${app.kebab}/web/*": ["./apps/web/*"],
      "@${app.kebab}/admin/*": ["./apps/admin/*"],
      "@${app.kebab}/*": ["./packages/*/src"]
    },
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "jsx": "preserve",
    "jsxImportSource": "solid-js"
  },
  "exclude": ["node_modules", "dist", ".x"]
}
`;

/**
 * The env half of `app.config.ts`, projected from `SCAFFOLD_ENV_SCHEMA` — never typed out here.
 * `envSchema` is a named export on purpose and not an inline argument: `defineEnv()` returns the
 * resolved VALUES, so an inline record is unreachable afterwards, and `.env.example`, `x env
 * check` and the gate's drift check are all projections of the record rather than of the values.
 */
const envDeclaration = (): string => `${envSchemaSource()}

/**
 * Validated once, at module scope, before anything listens: a missing or malformed key fails the
 * boot in ~40ms naming every offender at once, never as a 500 an hour later.
 */
export const env = defineEnv(envSchema);`;

const appConfig = (
  app: NameSet,
): string => `// The one config file. Everything the app needs to boot is here, typed and validated at startup —
// a missing value fails the boot with the exact command that fixes it, never at the first request.
// A named export, never a default: the CLI and the runtime both import \`config\` by name.
import type { EnvSchema } from '@ultimat3/core';
import { defineConfig, defineEnv } from '@ultimat3/core';

${envDeclaration()}

export const config = defineConfig({
  name: '${app.kebab}',
  locales: ['en'],
  defaultLocale: 'en',
  defaultTimeZone: 'UTC',
  defaultCurrency: 'USD',
  // Env KEYS, never the value: the same image deploys to every environment. The database is
  // configured entirely from the environment — \`DATABASE_URL\` and \`DATABASE_POOL_MAX\`.
  cache: { driver: 'memory', tiers: ['memo', 'lru'] },
  jobs: { driver: 'postgres', queues: ['${app.kebab}-default'], concurrency: 4 },
  // In-process transport by default; set urlEnv and transport: 'nats' to scale past one node.
  realtime: { enabled: true, tier: 'live-queries', transport: 'memory' },
  pwa: { enabled: true, offline: 'runtime', installPrompt: true },
  ai: { mcp: { expose: true, path: '/mcp' } },
});
`;

// `biome.json` is strict JSON — Biome's own parser rejects a `//` comment in it, which made every
// scaffolded app fail its first `x verify` on the config rather than on the code. The note that
// used to be a comment lives here, where it is read by the person who would have changed the line:
// x.manifest.json and openapi.json are emitted byte-for-byte by `x manifest`, so a formatter
// rewriting them puts `x manifest` and `x verify` in a loop neither can win. `**/migrations` is the
// same rule for the same reason and the same glob this repo's own biome.json carries: `x db gen`
// writes the `.sql` and its `.snapshot.json` sidecar, and an app that narrows `lineWidth` would
// otherwise fail `lint` on a file no author typed and `x db gen` would rewrite anyway.
// `preset`, not `recommended`: the older key is deprecated from 2.5 on and every `bun run lint`
// in the scaffolded app printed the migration notice for a config the app never wrote by hand.
const biome = (): string => `{
  "$schema": "https://biomejs.dev/schemas/${BIOME_VERSION}/schema.json",
  "files": {
    "includes": ["**", "!**/migrations", "!x.manifest.json", "!openapi.json"]
  },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "rules": {
      "preset": "recommended",
      "suspicious": { "noExplicitAny": "error" },
      "correctness": { "noUnusedVariables": "error", "noUnusedImports": "error" }
    }
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  }
}
`;

/**
 * The suite ratchet, committed on day one. Without it `readVerifyFloor` answers "no file is no
 * floor" and a deleted suite turns its step from green into skipped-and-green — so
 * `X_VERIFY_SUITE_VANISHED` was unreachable in every generated app, in the one repo shape that
 * grows suites fastest.
 *
 * Every name here is a step this scaffold has proved it can run: the SIX that declare no `applies`
 * at all — typecheck, lint, boundaries, filesize, errors, manifest — plus `package-shape` (five
 * workspace packages), `unit` (every generator emits a `<file>.test.ts`; like every suite step it
 * applies on its own file list, `verify-tests.ts`), and `eval`, `drift` and `budgets`, which apply
 * to any root with an `app.config.ts`. Typed as `VerifyStepName`, so a name the gate does not run
 * is a compile error rather than a floor that covers nothing.
 *
 * Plus `contract`, which every variant now ships a file for — `apps/web/api/health.contract.test.ts`
 * — and, with the example slice, `live` and `job`: its query is a `liveTest` and its job a
 * `jobTest`, and both were written into plain `<name>.test.ts` files that the `unit` step ran while
 * `x test live` and `x test job` answered X_TEST_NO_FILES. This is the commit that makes the app's
 * own gate run them, which is what the paragraph below always said the condition was.
 *
 * Two remain absent. `e2e` has a scaffolded file and it is an `e2eTest` — `test.skip` until the app
 * registers a browser driver, so the step would run zero tests and fail the ratchet on the
 * scaffold's own placeholder. `contract-diff` needs a committed `x.manifest.json`, which
 * `x manifest` writes later. Each joins the list in the commit that makes the app's gate run it.
 */
const SCAFFOLD_FLOOR: readonly VerifyStepName[] = [
  'typecheck',
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
  'unit',
  'contract',
  'eval',
  'drift',
  'budgets',
  'manifest',
];

/** The two suites only the example slice writes a file for — a floor step with no file is red. */
const EXAMPLE_FLOOR: readonly VerifyStepName[] = ['live', 'job'];

const verifyFloor = (example: boolean): string =>
  `${JSON.stringify({ steps: example ? [...SCAFFOLD_FLOOR, ...EXAMPLE_FLOOR] : SCAFFOLD_FLOOR }, null, 2)}\n`;

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

// A plain stylesheet is the global layer: it emits top-level CSS and has no class map worth
// binding, so \`shared/global.ts\` imports it for the side effect alone. Without this declaration
// \`tsc\` reports TS2307 on the one import that puts the app's tokens in the document.
declare module '*.scss' {
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

// Values, not declarations — the declaration is `envSchema` and `.env.example` is its projection.
// Every key here is one `envSchema` declares, plus `ROLE`, which `@ultimat3/core` reads directly
// (`roles.ts`) and no app schema may redeclare.
const envDevelopment =
  (): string => `# Committed non-secret defaults. Per-box secrets go in .env.development.local, which wins.
# Empty DATABASE_URL means "embedded": x dev runs PGlite in-process, no Docker required.
DATABASE_URL=
NATS_URL=
PORT=3000
SESSION_SECRET=dev-only-not-a-real-secret
ROLE=web
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
    { path: VERIFY_FLOOR_FILE, contents: verifyFloor(example) },
    { path: 'types/scss.d.ts', contents: scssTypes() },
    { path: '.gitignore', contents: gitignore() },
    { path: '.env.development', contents: envDevelopment() },
    // Committed, and generated: `x env example` rewrites this file from `envSchema`, and the
    // gate's `manifest` step fails with X_ENV_EXAMPLE_DRIFT when the two stop agreeing. A
    // scaffold that shipped a hand-written one would fail its own first `x verify`.
    { path: ENV_EXAMPLE_PATH, contents: envExampleSource() },
    // One call per workspace package, in write order. Each owns its own files (`scaffold-i18n.ts`
    // already did), so this list stays a table of contents rather than a second copy of every
    // package's contents.
    ...domainPackageFiles(app),
    ...dbPackageFiles(app, example),
    ...i18nFiles(app, version),
    ...uiPackageFiles(app),
    ...mcpPackageFiles(app),
  ];
}
