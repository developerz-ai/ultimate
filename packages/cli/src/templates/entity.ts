// `x g entity <name>` — a table, its domain type and its invariants, plus the repo that owns the
// only DB access for the feature. Emitted as strings rather than copied fixture files so the
// generator output is typed, diffable and testable from a unit test.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { wrapImport, wrapList } from './wrap';

/** The columns that leave the server. One list, read by the declaration and by its test. */
const VIEW_KEYS: readonly string[] = ["'id'", "'title'", "'price'", "'createdAt'"];

export interface FeatureTarget {
  /** `apps/web/app` or `apps/web/site` — the surface the feature lives in. */
  readonly surfaceDir: string;
  readonly feature: string;
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

const repoSource = (name: NameSet, table: string): string => {
  const row = name.pascal;
  const byIdCall = wrapList(
    '  ',
    `const row = await db().one<${row}>(`,
    [`sql\`select * from ${table} where id = \${id}\``],
    ');',
  );
  const listSignature = wrapList(
    '',
    'export async function listByOrg(',
    ['orgId: string', 'limit = 50'],
    `): Promise<readonly ${row}[]> {`,
  );
  const insertSignature = wrapList(
    '',
    'export async function insert(',
    [`row: Omit<${row}, 'id' | 'createdAt'>`],
    `): Promise<${row}> {`,
  );
  return `// The only module allowed to query the ${name.pluralKebab} table. Routes call actions and
// queries; actions call services; services call this.
// \`db()\` is the ambient handle: inside a transaction it IS the transaction, so these functions
// join the caller's transaction without knowing one is open.

import { db, sql } from '@ultimat3/db';
import { dbDrift, newId } from '@ultimat3/entity';
import type { ${name.pascal} } from './entity';

export async function byId(id: string): Promise<${name.pascal} | undefined> {
${byIdCall}
  return row ?? undefined;
}

${listSignature}
  // Ordered and bounded: an unordered page is a different page on every request.
  return db().query<${name.pascal}>(
    sql\`select * from ${table} where org_id = \${orgId} order by created_at desc limit \${limit}\`,
  );
}

${insertSignature}
  // Money is three physical columns — integer minor units, the ISO code, and the scale, never a
  // float. \`scale ?? null\`: an amount at the currency's own minor unit carries no scale at all,
  // and writing \`0\` for it would claim whole units — a 100x reinterpretation of the price.
  const created = await db().one<${name.pascal}>(sql\`
    insert into ${table} (id, org_id, title, price_minor, price_currency, price_scale)
    values (\${newId()}, \${row.orgId}, \${row.title}, \${row.price.minor}, \${row.price.currency},
            \${row.price.scale ?? null})
    returning *\`);
  if (created === null) throw dbDrift('${table}', 'id');
  return created;
}
`;
};

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
  return [
    { path: `${dir}/entity.ts`, contents: entitySource(name, name.snake, name.table) },
    { path: `${dir}/entity.test.ts`, contents: entityTest(name, name.snake, name.table) },
    { path: `${dir}/repo.ts`, contents: repoSource(name, name.table) },
  ];
}
