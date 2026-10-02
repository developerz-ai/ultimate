// `x g entity <name>` — a table, its domain type and its invariants, plus the repo that owns the
// only DB access for the feature and reads through the app's typed handle. Emitted as strings
// rather than copied fixture files so the generator output is typed, diffable and testable from a
// unit test.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { LINE_WIDTH, wrapImport, wrapList } from './wrap';

/** The columns that leave the server. One list, read by the declaration and by its test. */
const VIEW_KEYS: readonly string[] = ["'id'", "'title'", "'price'", "'createdAt'"];

export interface FeatureTarget {
  /** `apps/web/app` or `apps/web/site` — the surface the feature lives in. */
  readonly surfaceDir: string;
  readonly feature: string;
  /**
   * The app's own db package, `@<app>/db` — where the generated `repo.ts` imports the typed handle
   * from. Supplied by `x g` (read off `packages/db/package.json`) and by `x new`; absent only in a
   * pure call that names no app, which gets `PLACEHOLDER_DB_MODULE`.
   */
  readonly dbModule?: string;
}

const entitySource = (
  name: NameSet,
  snake: string,
  table: string,
): string => `// The ${name.camel} table, its domain type and its invariants. No I/O beyond the column
// definitions: repo.ts owns every query that touches this table.

import { entity, invariant, money, text, timestamp, uuid } from '@ultimat3/entity';

export const ${name.camel} = entity('${table}', {
  // Naming the tenant column is what turns tenancy on: a read without an org predicate then
  // fails with X_TENANCY_UNSCOPED instead of leaking another org's rows.
  //
  // SINGLE-TENANT APP? There is no flag: \`x g action\`, \`x g query\` and \`x g policy\` decide on
  // \`orgId\` too, so the edit is per slice and it is this: delete \`tenant: 'orgId'\` and the
  // \`orgId: uuid()\` column below and drop \`'orgId'\` from \`indexes\`. repo.ts needs no edit —
  // it names no org. entity.test.ts then expects \`$tenantColumn\` null and \`orgScoped\` false,
  // its \`row()\` fixture and repo.test.ts's \`draft()\` lose \`orgId\`, and repo.test.ts loses its
  // last test. Nothing else reads the column.
  tenant: 'orgId',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text({ max: 200 }),
    // One property, three physical columns: price_minor bigint + price_currency char(3) +
    // the nullable price_scale integer. Money is integer minor units plus an ISO code, never a
    // float; the scale is what lets an amount name a sub-cent value, and NULL is not 0.
    price: money(),
    // Always timestamptz. Stored UTC; formatted at the edge with an explicit IANA time zone.
    createdAt: timestamp().defaultNow(),
  },
  // Each rule runs in the app on write AND as a Postgres CHECK — one declaration, both sides.
  // \`c\` is typed from the columns above: \`c.titel\` is a compile error that names \`title\`.
  invariants: (c) => [
    invariant('${snake}_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('${snake}_price_non_negative', c.price.minor.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type ${name.pascal} = typeof ${name.camel}.$row;

// What leaves the server: an action writes \`output: ${name.pascal}View\` and the shape is the
// columns', never a second declaration to keep in sync. The tenant column is not in it — an org
// id is the caller's context, not the client's data.
${wrapList('', `export const ${name.pascal}View = ${name.camel}.$view([`, VIEW_KEYS, ']);')}
export type ${name.pascal}View = typeof ${name.pascal}View.$row;
`;

/**
 * A fluent read the way Biome prints it: on one line while it fits, one call per line when it does
 * not. The name decides which — `db.creditNoteAttachments` breaks a chain `db.posts` does not — so
 * a fixed shape is a red `lint` over code nobody typed.
 */
const chain = (indent: string, head: string, calls: readonly string[]): string => {
  const joined = `${indent}${head}${calls.join('')};`;
  if (joined.length <= LINE_WIDTH) return joined;
  return `${indent}${head}\n${calls.map((call) => `${indent}  ${call}`).join('\n')};`;
};

const repoSource = (name: NameSet, dbModule: string): string => {
  const row = name.pascal;
  const table = `db.${name.plural}`;
  const listSignature = wrapList(
    '',
    'export async function list(',
    ['limit = 50'],
    `): Promise<readonly ${row}[]> {`,
  );
  const byIdSignature = wrapList(
    '',
    'export async function byId(',
    ['id: string'],
    `): Promise<${row} | undefined> {`,
  );
  const byIdBody = `  return (await ${table}.where({ id }).one()) ?? undefined;`;
  const insertSignature = wrapList(
    '',
    'export async function insert(',
    [`row: Omit<${row}, 'id' | 'createdAt'>`],
    `): Promise<${row}> {`,
  );
  const listChain = chain('  ', `return ${table}`, [
    ".orderBy('createdAt', 'desc')",
    '.limit(limit)',
    '.all()',
  ]);
  return `// The only module allowed to query the ${name.pluralKebab} table. Routes call actions and
// queries; actions call services; services call this.
//
// Every statement goes through the typed handle (\`db.<table>\`), so a renamed column is a compile
// error here and there is no SQL text to keep in step with the entity. The handle owns the rest:
// tenancy (every read runs under the ACTOR's org, so no function here takes or names one), the
// codecs (money is one property; a sealed column is opened on read), keyset paging (\`.limit()\`,
// \`.after(cursor)\`) and the ambient transaction.
//
// Raw SQL has two homes and neither is this file: a \`query\`'s source and a migration. Reach for
// it here only for a statement the handle cannot express — a join, a window, a CTE.

import { db } from '${dbModule}';
import type { ${row} } from './entity';

${byIdSignature}
${byIdBody}
}

${listSignature}
  // The actor's org and nobody else's: the handle scopes the read, so there is no org to pass.
  // Ordered and bounded — an unordered page is a different page on every request — and the handle
  // adds the primary key as the last sort key, so the order is total without \`id\` spelled here.
${listChain}
}

${insertSignature}
  // \`id\` and \`createdAt\` are the declaration's defaults, filled by the handle. The row names its
  // org, and one that is not the actor's is refused (X_TENANCY_ACTOR_MISMATCH).
  return ${table}.insert(row);
}
`;
};

/**
 * The repo's own test, emitted beside it: a generated file with no test is uncovered source in an
 * app whose gate holds a coverage floor. Runs against the in-memory driver — the same contract
 * Postgres serves — so it needs no database.
 */
const repoTest = (
  name: NameSet,
  dbModule: string,
): string => `// The ${name.kebab} repo against the in-memory driver: the contract Postgres serves, with no
// database. What it pins is what the repo cannot show by being read — whose rows a call reaches.
${sortedImports([
  "import { createContext, frozenClock, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { afterEach, expect, unitTest } from '@ultimat3/testing';",
  `import { driver } from '${dbModule}';`,
])}
import * as repo from './repo';

const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';

// The request clock, so \`createdAt\` is an instant this file chose and "newest" is decidable.
const clock = frozenClock('2026-01-01T00:00:00.000Z');

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(org: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: testActor('member', { orgId: org }).actor, clock }), run);

const draft = (title: string) => ({ orgId, title, price: { minor: 1200, currency: 'USD' } });

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('insert stores the row and byId reads it back', async () => {
  const stored = await inOrg(orgId, () => repo.insert(draft('first')));
  // Neither was supplied: the entity's own defaults filled both.
  expect(stored.id).toHaveLength(36);
  expect(stored.createdAt).toEqual(clock.now());
  expect(stored.price).toEqual({ minor: 1200, currency: 'USD' });
  // \`toEqualRow\`, never \`toEqual\`: a \`.sealed()\` column is a non-enumerable property of a row,
  // so \`toEqual\` would call two rows equal that hold different secrets.
  expect(await inOrg(orgId, () => repo.byId(stored.id))).toEqualRow(stored);
});

unitTest('byId answers undefined for an id nothing holds', async () => {
  const absent = '00000000-0000-4000-8000-0000000000ff';
  expect(await inOrg(orgId, () => repo.byId(absent))).toBeUndefined();
});

unitTest('list is newest first and bounded', async () => {
  for (const title of ['first', 'second', 'third']) {
    await inOrg(orgId, () => repo.insert(draft(title)));
    clock.advance(1000);
  }
  const page = await inOrg(orgId, () => repo.list(2));
  expect(page.map((row) => row.title)).toEqual(['third', 'second']);
});

unitTest('an actor in another org never reads the row, and no call names an org', async () => {
  const stored = await inOrg(orgId, () => repo.insert(draft('private')));
  // Neither read takes an org: the handle scopes both to the actor it runs under.
  expect(await inOrg(otherOrg, () => repo.byId(stored.id))).toBeUndefined();
  expect(await inOrg(otherOrg, () => repo.list())).toEqual([]);
  expect(await inOrg(orgId, () => repo.list())).toHaveLength(1);
});

unitTest('a read with no actor is refused rather than answered for every org', async () => {
  const refused = await repo.list().catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_TENANCY_UNSCOPED');
});
`;

const entityTest = (
  name: NameSet,
  snake: string,
  table: string,
): string => `// The ${name.kebab} entity's declaration: the table it maps to and the invariants it names. Both
// are what the migration generator and every query read, so both are worth pinning.
import { expect, unitTest } from '@ultimat3/testing';
import type { ${name.pascal} } from './entity';
${wrapImport([`${name.pascal}View`, name.camel], './entity')}

type Over = Partial<${name.pascal}>;

const row = (over: Over = {}): ${name.pascal} => ({
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  title: 'valid title',
  // \`money()\` puts \`MoneyValue\` on the row — the same type \`@ultimat3/money\`'s \`Money\` is,
  // so this value goes straight to \`add()\`, \`formatMoney()\` and \`<Money>\` with no conversion.
  // Integer minor units, never a float; the column is a Postgres bigint and a stored value past
  // ±2^53 is refused when it is read rather than rounded into the row.
  price: { minor: 1000, currency: 'USD' },
  createdAt: new Date(0),
  ...over,
});

unitTest('${name.camel} declares a table with invariants', () => {
  expect(${name.camel}.$name).toBe('${table}');
  expect(${name.camel}.$tenantColumn).toBe('orgId');
  const named = ${name.camel}.$invariants.map((rule) => rule.name);
  expect(named).toContain('${snake}_title_not_blank');
});

unitTest('${name.camel} describes itself for the manifest', () => {
  // \`$describe()\` is what x manifest, /_x and the MCP dev tools all read — one projection, so
  // a column added below reaches every one of them without a second declaration.
  const described = ${name.camel}.$describe();
  expect(described.orgScoped).toBe(true);
  // One \`price\` property, three physical columns: integer minor units, the ISO code, and the
  // nullable scale. The description is where that shows, and it is what fails here if money ever
  // becomes a float — or if a migration forgets the scale column and unscales every sub-cent row.
  expect(described.columns.map((column) => column.column)).toContain('price_minor');
  expect(described.columns.map((column) => column.column)).toContain('price_currency');
  expect(described.columns.map((column) => column.column)).toContain('price_scale');
  // Named first: the assertion line carries the entity's own name and stays under the app's
  // formatter width whatever that name is.
  const rules = described.invariants.map((rule) => rule.name);
  expect(rules).toContain('${snake}_price_non_negative');
});

unitTest('${name.pascal}View projects the row an action returns', () => {
  const keys = ${name.pascal}View.$keys;
  expect(keys).toEqual([${VIEW_KEYS.join(', ')}]);
  // The org id is the caller's context, never the client's data: a view that leaked it would
  // let a response carry a tenant boundary the policy already decided.
  expect(keys).not.toContain('orgId');
});

unitTest('${name.camel} invariants reject blank and negative', () => {
  const blank = row({ title: '   ' });
  const negative = row({ price: { minor: -1, currency: 'USD' } });
  expect(() => ${name.camel}.$assert(row())).not.toThrow();
  expect(() => ${name.camel}.$assert(blank)).toThrow();
  expect(() => ${name.camel}.$assert(negative)).toThrow();
});

unitTest('${name.camel} parses a row through its own columns', () => {
  // \`$parse\` is the entity's own coercion, so a row read back from SQL and a row built in a
  // test go through the same code — a drifting column type fails here first.
  const parsed = ${name.camel}.$parse(row());
  expect(parsed.title).toBe('valid title');
  expect(parsed.price.currency).toBe('USD');
});
`;

export function entityFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const dir = `${target.surfaceDir}/${target.feature}`;
  const dbModule = target.dbModule ?? PLACEHOLDER_DB_MODULE;
  return [
    { path: `${dir}/entity.ts`, contents: entitySource(name, name.snake, name.table) },
    { path: `${dir}/entity.test.ts`, contents: entityTest(name, name.snake, name.table) },
    { path: `${dir}/repo.ts`, contents: repoSource(name, dbModule) },
    { path: `${dir}/repo.test.ts`, contents: repoTest(name, dbModule) },
  ];
}
