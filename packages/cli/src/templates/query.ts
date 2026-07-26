// `x g query <name> [--live]` — a read. Live queries must be deterministic and bounded, so the
// generated declaration always carries `orderBy` + `limit` and the generated test pins them:
// an unbounded live query is a memory leak that only shows up under load.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const querySource = (
  name: NameSet,
  feature: NameSet,
  live: boolean,
): string => `// ${name.camel}: a ${live ? 'live (subscribable)' : 'one-shot'} read over ${feature.pluralKebab}.
// Bounded and ordered — required for${live ? ' live queries' : ' predictable pagination'}.
import { db } from '@ultimat3/db';
import { can } from '@ultimat3/policy';
import { query, t } from '@ultimat3/query';
import { ${feature.camel} } from '../entity';

export const ${name.camel} = query({
  input: t.object({ orgId: t.uuid, limit: t.number.default(50) }),
  policy: can('${feature.kebab}:read'),
  live: ${String(live)},
  sql: ({ orgId, limit }) =>
    db.select().from(${feature.camel}).where({ orgId }).orderBy('createdAt').limit(limit),
});
`;

const queryTest = (name: NameSet, live: boolean): string => `import { expect } from 'bun:test';
import { ${live ? 'liveTest' : 'unitTest'} } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

${live ? 'liveTest' : 'unitTest'}('${name.camel} is a declared query', () => {
  expect(${name.camel}.kind).toBe('query');
  expect(${name.camel}.live).toBe(${String(live)});
});

${live ? 'liveTest' : 'unitTest'}('${name.camel} is bounded and ordered', () => {
  const sql = String(${name.camel}.sql({ orgId: '00000000-0000-0000-0000-000000000002', limit: 50 }));
  expect(sql.toLowerCase()).toContain('order by');
  expect(sql.toLowerCase()).toContain('limit');
});

${live ? 'liveTest' : 'unitTest'}('${name.camel} requires an actor with read permission', async () => {
  await expect(${name.camel}.policy).toDenyPolicy({
    actor: null,
    input: { orgId: '00000000-0000-0000-0000-000000000002', limit: 50 },
  });
});
`;

export interface QueryOptions extends FeatureTarget {
  readonly live?: boolean;
}

export function queryFiles(rawName: string, target: QueryOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const live = target.live === true;
  const dir = `${target.surfaceDir}/${target.feature}/${live ? 'live' : 'queries'}`;
  return [
    { path: `${dir}/${name.kebab}.ts`, contents: querySource(name, feature, live) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: queryTest(name, live) },
  ];
}
