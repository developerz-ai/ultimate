// `x g entity <name>` — a table, its domain type and its invariants, plus the repo that owns the
// only DB access for the feature. Emitted as strings rather than copied fixture files so the
// generator output is typed, diffable and testable from a unit test.

import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

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
  columns: {
    id: uuid().primaryKey(),
    // Declaring the tenant column is what turns tenancy on: a read without an org predicate
    // then fails with X_TENANCY_UNSCOPED instead of leaking another org's rows.
    orgId: uuid().tenant(),
    title: text({ max: 200 }),
    // One property, two physical columns: price_minor bigint + price_currency char(3).
    // Money is integer minor units plus an ISO code, never a float.
    price: money(),
    // Always timestamptz. Stored UTC; formatted at the edge with an explicit IANA time zone.
    createdAt: timestamp().defaultNow(),
  },
  // Each rule runs in the app on write AND as a Postgres CHECK — one declaration, both sides.
  invariants: [
    invariant('${snake}_title_not_blank', (c) => c.title.trimmed().minLength(1)),
    invariant('${snake}_price_non_negative', (c) => c.price.minor.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type ${name.pascal} = typeof ${name.camel}.$row;
`;

const repoSource = (
  name: NameSet,
  snake: string,
): string => `// The only module allowed to query the ${name.pluralKebab} table. Routes call actions and
// queries; actions call services; services call this.
// \`db()\` is the ambient handle: inside a transaction it IS the transaction, so these functions
// join the caller's transaction without knowing one is open.
import { db, sql } from '@ultimat3/db';
import { dbDrift, newId } from '@ultimat3/entity';
import type { ${name.pascal} } from './entity';

export async function byId(id: string): Promise<${name.pascal} | undefined> {
  const row = await db().one<${name.pascal}>(sql\`select * from ${snake} where id = \${id}\`);
  return row ?? undefined;
}

export async function listByOrg(orgId: string, limit = 50): Promise<readonly ${name.pascal}[]> {
  // Ordered and bounded: an unordered page is a different page on every request.
  return db().query<${name.pascal}>(
    sql\`select * from ${snake} where org_id = \${orgId} order by created_at desc limit \${limit}\`,
  );
}

export async function insert(row: Omit<${name.pascal}, 'id' | 'createdAt'>): Promise<${name.pascal}> {
  // Money is two physical columns — integer minor units plus the ISO code, never a float.
  const created = await db().one<${name.pascal}>(sql\`
    insert into ${snake} (id, org_id, title, price_minor, price_currency)
    values (\${newId()}, \${row.orgId}, \${row.title}, \${row.price.minor}, \${row.price.currency})
    returning *\`);
  if (created === null) throw dbDrift('${snake}', 'id');
  return created;
}
`;

const entityTest = (
  name: NameSet,
  snake: string,
  table: string,
): string => `import { expect, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './entity';
import type { ${name.pascal} } from './entity';

const row = (over: Partial<${name.pascal}> = {}): ${name.pascal} => ({
  id: '00000000-0000-0000-0000-000000000001',
  orgId: '00000000-0000-0000-0000-000000000002',
  title: 'valid title',
  price: { minor: 1000n, currency: 'USD' },
  createdAt: new Date(0),
  ...over,
});

unitTest('${name.camel} declares a table with invariants', () => {
  expect(${name.camel}.$name).toBe('${table}');
  expect(${name.camel}.$tenantColumn).toBe('orgId');
  const named = ${name.camel}.$invariants.map((rule) => rule.name);
  expect(named).toContain('${snake}_title_not_blank');
});

unitTest('${name.camel} invariants reject a blank title and a negative price', () => {
  expect(() => ${name.camel}.$assert(row())).not.toThrow();
  expect(() => ${name.camel}.$assert(row({ title: '   ' }))).toThrow();
  expect(() => ${name.camel}.$assert(row({ price: { minor: -1n, currency: 'USD' } }))).toThrow();
});
`;

export function entityFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  // Constraint and table names are snake_case: Postgres lowercases every unquoted identifier,
  // and a hyphen would have to be quoted at every call site forever.
  const snake = name.kebab.split('-').join('_');
  const table = name.pluralKebab.split('-').join('_');
  const dir = `${target.surfaceDir}/${target.feature}`;
  return [
    { path: `${dir}/entity.ts`, contents: entitySource(name, snake, table) },
    { path: `${dir}/entity.test.ts`, contents: entityTest(name, snake, table) },
    { path: `${dir}/repo.ts`, contents: repoSource(name, table) },
  ];
}
