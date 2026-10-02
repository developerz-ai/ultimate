// The generated app's `packages/db/src/client.ts`: the ONE typed database handle, and the entity
// set `x g entity` / `x g resource` add to. Its own module rather than a section of
// `scaffold-db-package.ts` because `handle-registration.ts` writes the same file into an app that
// predates it — one template, two writers.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

/** Where the handle lives, relative to the app root. The generators' one anchor. */
export const HANDLE_FILE = 'packages/db/src/client.ts';

/** The scope a pure call that names no app writes — `x g` and `x new` always name theirs. */
export const PLACEHOLDER_DB_MODULE = '@app/db';

/** One entity in the handle's set. */
export interface HandleEntry {
  /** The key on the handle — the table's name, camelCase: `db.posts`. */
  readonly key: string;
  /** The entity's exported binding: `post`. */
  readonly binding: string;
  /** Where the binding is imported from: `@myapp/web/app/post/entity`. */
  readonly specifier: string;
}

/** The line an entity takes in the set. Spelled once: the template and the registrar both write it. */
export const handleEntryLine = (entry: HandleEntry): string => `  ${entry.key}: ${entry.binding},`;

/** The import that line needs. */
export const handleImportLine = (entry: HandleEntry): string =>
  `import { ${entry.binding} } from '${entry.specifier}';`;

/**
 * The web workspace's package name, from the db package's: both carry the app's scope, which is
 * how `x new` names them and how the root tsconfig's `paths` resolves them.
 */
export const webModuleOf = (dbModule: string): string =>
  `${dbModule.slice(0, dbModule.lastIndexOf('/'))}/web`;

/**
 * The entry for the entity `x g entity <rawName>` writes into `<surfaceDir>/<feature>/entity.ts`.
 * The key is `NameSet.plural` — the same word `repo.ts` reads the table under.
 */
export function handleEntryFor(
  rawName: string,
  target: { readonly surfaceDir: string; readonly feature: string; readonly dbModule: string },
): HandleEntry {
  const name = names(rawName);
  // `apps/web/app` → `app`: the web workspace's own root is what its package name stands for.
  const inWorkspace = target.surfaceDir.split('/').slice(2).join('/');
  return {
    key: name.plural,
    binding: name.camel,
    specifier: `${webModuleOf(target.dbModule)}/${inWorkspace}/${target.feature}/entity`,
  };
}

const entitySet = (entries: readonly HandleEntry[]): string =>
  entries.length === 0
    ? 'const entities = {};'
    : `const entities = {\n${entries.map(handleEntryLine).join('\n')}\n};`;

/**
 * The handle, over `entries`. The set is a named, one-entry-per-line object on purpose: it is the
 * anchor `x g entity` inserts a line into, and an expanded object literal is a shape Biome leaves
 * alone at any length — an inline `database({ a, b }, …)` re-wraps as it grows.
 */
export const dbClientSource = (
  entries: readonly HandleEntry[],
): string => `// The one typed database handle. \`db.<table>\` exists because the entity is in the set below —
// nobody writes a repository class per entity, and nobody can reach a table that is not listed.
//
// \`x g entity\` and \`x g resource\` add their entity to \`entities\`. One written by hand is the
// same two lines: its import, and \`<tableName>: <entity>,\` in the set.

${sortedImports([
  "import { resolveEnvironment } from '@ultimat3/core';",
  "import { type Driver, database, memoryDriver, postgresDriver } from '@ultimat3/entity';",
  ...entries.map(handleImportLine),
])}

/**
 * One driver, NAMED rather than defaulted, and exported so a test resets the same object the app
 * reads through (\`driver.reset?.()\`).
 *
 * \`postgresDriver()\` takes no connection: it resolves \`@ultimat3/db\`'s process client, which is
 * the embedded PGlite under \`x dev\` and the \`DATABASE_URL\` pool in a container. \`bun test\`
 * installs no client, so a test gets the in-memory driver — the same contract, no database.
 */
export const selectDriver = (env: Readonly<Record<string, string | undefined>>): Driver =>
  resolveEnvironment({ env }) === 'test' ? memoryDriver() : postgresDriver();

export const driver = selectDriver(Bun.env);

/** Every entity the handle serves, keyed by the name its table takes on \`db\`. */
${entitySet(entries)}

/**
 * Only a feature's \`repo.ts\`, a \`query\`'s \`sql\` or a seed may use this. A route importing it is
 * \`X_BOUNDARY_ROUTE_TO_DB\`.
 */
export const db = database(entities, { driver });

export type Db = typeof db;
`;

const clientTest = (
  app: NameSet,
): string => `// Which store the handle reads: memory under \`bun test\`, the process's Postgres client
// everywhere else. A handle that silently took the memory driver in a container would serve an
// empty database with a green gate.
import { expect, unitTest } from '@ultimat3/testing';
import { db, driver, selectDriver } from './client';

unitTest('${app.kebab} reads memory under test and Postgres everywhere else', () => {
  // Only the in-memory driver can empty itself — a Postgres driver that could truncate an app's
  // rows from a test eventually would — so \`reset\` is what tells the two apart.
  expect(selectDriver({ NODE_ENV: 'test' }).reset).toBeDefined();
  expect(selectDriver({ NODE_ENV: 'production' }).reset).toBeUndefined();
  expect(selectDriver({ ULTIMATE_ENV: 'development' }).reset).toBeUndefined();
});

unitTest('the handle is built over the driver this module exports', () => {
  expect(driver.reset).toBeDefined();
  expect(typeof db).toBe('object');
});
`;

/**
 * `packages/db/src/client.ts` and its test. With the example slice the set holds `post`; under
 * `--no-example` it is empty and the first `x g entity` fills it.
 */
export const dbClientFiles = (app: NameSet, example: boolean): readonly GeneratedFile[] => {
  const dbModule = `@${app.kebab}/db`;
  const entries = example
    ? [handleEntryFor('post', { surfaceDir: 'apps/web/app', feature: 'post', dbModule })]
    : [];
  return [
    { path: HANDLE_FILE, contents: dbClientSource(entries) },
    { path: 'packages/db/src/client.test.ts', contents: clientTest(app) },
  ];
};
