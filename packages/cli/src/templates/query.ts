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
import { from, query } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import type { ${feature.pascal} } from '../entity';
import { can${feature.pascal}Read } from '../policy';
import * as repo from '../repo';

export const ${name.camel} = query({
  input: t.object({ orgId: t.uuid, limit: t.number.default(50) }),
  policy: can${feature.pascal}Read,
  live: ${String(live)},
  sql: ({ orgId, limit }) =>
    // \`feature.table\`, not the kebab plural: \`from()\` quotes the identifier into the SQL text,
    // and the entity created the table as snake_case.
    from<${feature.pascal}>('${feature.table}', () => repo.listByOrg(orgId, limit))
      .where({ orgId })
      .orderBy('createdAt')
      .limit(limit),
});
`;

const queryTest = (name: NameSet, live: boolean): string => {
  const wrapper = live ? 'liveTest' : 'unitTest';
  return `import { anonymousCtx } from '@ultimat3/action';
import { sourceFor } from '@ultimat3/query';
import { expect, ${wrapper} } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// A real v4 uuid: \`sourceFor\` parses the input the way a request does, so a placeholder that
// only looks like a uuid would fail the read before it ever built any SQL.
const orgId = '00000000-0000-4000-8000-000000000002';

${wrapper}('${name.camel} is a declared query', () => {
  expect(${name.camel}.kind).toBe('query');
  expect(${name.camel}.isLive).toBe(${String(live)});
});

${wrapper}('${name.camel} is bounded and ordered', async () => {
  // The SQL text is the contract an agent reads to self-correct, so assert on it, not on a shape.
  // \`sourceFor\` is the one read path — it parses the input and builds the source exactly as a
  // request does; \`enforce: false\` skips the policy, which the next test covers on its own.
  // \`named\` because a read needs a name to project: at boot \`registerQueries\` supplies it.
  const source = await sourceFor(
    ${name.camel}.named('${name.camel}'),
    { orgId, limit: 50 },
    { ctx: anonymousCtx(), enforce: false },
  );
  const { sql } = source.toSQL();
  expect(sql.toLowerCase()).toContain('order by');
  expect(sql.toLowerCase()).toContain('limit');
});

${wrapper}('${name.camel} requires an actor with read permission', async () => {
  await expect(${name.camel}.policy).toDenyPolicy({ actor: null, input: { orgId } });
});
`;
};

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
