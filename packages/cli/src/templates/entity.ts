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
): string => `// The ${name.camel} table, its domain type and its invariants. No I/O beyond the column
// definitions: repo.ts owns every query that touches this table.
import { entity, t } from '@ultimat3/entity';

export const ${name.camel} = entity({
  table: '${name.pluralKebab}',
  columns: {
    id: t.uuid.primary(),
    orgId: t.uuid.references('orgs.id'),
    title: t.string.max(200),
    // Money is integer minor units + an ISO code, never a float.
    priceMinor: t.integer.default(0),
    priceCurrency: t.string.length(3).default('USD'),
    // Stored UTC; formatted at the edge with an explicit IANA time zone.
    createdAt: t.timestamp.defaultNow(),
  },
  invariants: {
    'title must not be blank': (row) => row.title.trim().length > 0,
    'price must not be negative': (row) => row.priceMinor >= 0,
  },
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type ${name.pascal} = typeof ${name.camel}.$type;
`;

const repoSource = (
  name: NameSet,
): string => `// The only module allowed to query the ${name.pluralKebab} table. Routes call actions and
// queries; actions call services; services call this.
import { db } from '@ultimat3/db';
import { ${name.camel} } from './entity';
import type { ${name.pascal} } from './entity';

export async function byId(id: string): Promise<${name.pascal} | undefined> {
  const rows = await db.select().from(${name.camel}).where({ id }).limit(1);
  return rows[0];
}

export async function listByOrg(orgId: string, limit = 50): Promise<readonly ${name.pascal}[]> {
  return db.select().from(${name.camel}).where({ orgId }).orderBy('createdAt').limit(limit);
}

export async function insert(row: Omit<${name.pascal}, 'id' | 'createdAt'>): Promise<${name.pascal}> {
  const [created] = await db.insert(${name.camel}).values(row).returning();
  if (created === undefined) throw new Error('insert returned no row');
  return created;
}
`;

const entityTest = (name: NameSet): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './entity';
import type { ${name.pascal} } from './entity';

const row = (over: Partial<${name.pascal}> = {}): ${name.pascal} => ({
  id: '00000000-0000-0000-0000-000000000001',
  orgId: '00000000-0000-0000-0000-000000000002',
  title: 'valid title',
  priceMinor: 1000,
  priceCurrency: 'USD',
  createdAt: new Date(0),
  ...over,
});

unitTest('${name.camel} declares a table with invariants', () => {
  expect(${name.camel}.kind).toBe('entity');
  expect(${name.camel}.table).toBe('${name.pluralKebab}');
  expect(Object.keys(${name.camel}.invariants)).toContain('title must not be blank');
});

unitTest('${name.camel} invariants reject a blank title and a negative price', () => {
  const { invariants } = ${name.camel};
  expect(invariants['title must not be blank'](row())).toBe(true);
  expect(invariants['title must not be blank'](row({ title: '   ' }))).toBe(false);
  expect(invariants['price must not be negative'](row({ priceMinor: -1 }))).toBe(false);
});
`;

export function entityFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const dir = `${target.surfaceDir}/${target.feature}`;
  return [
    { path: `${dir}/entity.ts`, contents: entitySource(name) },
    { path: `${dir}/entity.test.ts`, contents: entityTest(name) },
    { path: `${dir}/repo.ts`, contents: repoSource(name) },
  ];
}
