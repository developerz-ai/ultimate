// `x g query <name> [--live]` — a read. Live queries must be deterministic and bounded, so the
// generated declaration always carries `orderBy` + `limit` and the generated test pins them:
// an unbounded live query is a memory leak that only shows up under load.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

/** A live read always fans out fresh, so a TTL on it would only ever be dead configuration. */
const cacheLine = (feature: NameSet, live: boolean): string =>
  live ? '' : `\n  cache: { tags: [${feature.camel}Tag], ttlMs: 30_000 },`;

const querySource = (
  name: NameSet,
  feature: NameSet,
  live: boolean,
): string => `// ${name.camel}: a ${live ? 'live (subscribable)' : 'one-shot'} read over ${feature.pluralKebab}.
// Bounded and ordered — required for${live ? ' live queries' : ' predictable pagination'}.
// \`t\` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { from, query, t } from '@ultimat3/query';
import type { ${feature.pascal} } from '../entity';
import { can${feature.pascal}Read${live ? '' : `, ${feature.camel}Tag`} } from '../policy';
import * as repo from '../repo';

export const ${name.camel} = query({
  input: t.object({ orgId: t.uuid, limit: t.number.default(50) }),
  policy: can${feature.pascal}Read,
  live: ${String(live)},${cacheLine(feature, live)}
  // Opt-in, unlike an action's tool: a read hands rows to an agent, so silence exposes nothing.
  mcp: { expose: true, description: '${name.raw} — generated, edit the description' },
  sql: ({ orgId, limit }) =>
    // \`feature.table\`, not the kebab plural: \`from()\` quotes the identifier into the SQL text,
    // and the entity created the table as snake_case.
    from<${feature.pascal}>('${feature.table}', () => repo.listByOrg(orgId, limit))
      .where({ orgId })
      .orderBy('createdAt')
      // The primary key last is what makes the order TOTAL: \`createdAt\` alone ties, and two
      // rows that tie can swap between evaluations — a bounded read then drops one and repeats
      // the other, and a live subscription patches a row it never sent.
      .orderBy('id')
      .limit(limit),
});
`;

const queryTest = (name: NameSet, feature: NameSet, live: boolean): string => {
  const wrapper = live ? 'liveTest' : 'unitTest';
  return `import { testActor } from '@ultimat3/policy';
import { sourceFor } from '@ultimat3/query';
import { expect, ${wrapper} } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// A real v4 uuid: the read parses its input the way a request does, so a placeholder that only
// looks like a uuid would fail before it ever built any SQL.
const orgId = '00000000-0000-4000-8000-000000000002';

// Named here because every projection needs a stable name and this file does not boot the app.
// At boot \`registerQueries(await import('./${live ? 'live' : 'queries'}'))\` stamps the same name
// onto the same object.
const target = ${name.camel}.named('${name.camel}');

// Holds the grant, wrong org — so a denial here is the predicate deciding, not the grant.
const outsider = testActor('outsider', {
  orgId: '00000000-0000-4000-8000-000000000009',
  permissions: ['${feature.kebab}:read'],
}).actor;

${wrapper}('${name.camel} is a declared ${live ? 'live ' : ''}query', () => {
  expect(target.kind).toBe('query');
  expect(target.isLive).toBe(${String(live)});
});

${wrapper}('${name.camel} is bounded and TOTALLY ordered', async () => {
  // The SQL text is the contract an agent reads to self-correct, so assert on it, not on a
  // shape. \`sourceFor\` is the one read path — it parses the input and builds the source exactly
  // as a request does. \`actor: null\` gives the call a context of its own rather than borrowing
  // an ambient one, and \`unenforced\` states WHY the policy is skipped: the escape hatch takes a
  // written reason, never a boolean, because a boolean reads exactly like forgetting the policy.
  const source = await sourceFor(
    target,
    { orgId, limit: 50 },
    {
      actor: null,
      unenforced: 'a scaffolded test asserts the SQL text; the policy is asserted separately',
    },
  );
  const { sql } = source.toSQL();
  const text = sql.toLowerCase();
  expect(text).toContain('order by');
  expect(text).toContain('limit');
  // "ordered" is not enough. Dropping the id tiebreak still leaves an ORDER BY, so asserting on
  // its presence alone would keep passing while the read went non-deterministic under ties.
  expect(text.slice(text.lastIndexOf('order by'))).toContain('id');
});

${wrapper}('${name.camel} denies a foreign org before it reads a row', async () => {
  // \`.as()\` is the one read path with the actor swapped: validate, authorize, then read. The
  // denial lands before any SQL executes, which is why this needs no database.
  const denied = await target.as(outsider, { orgId, limit: 50 }).catch((error: unknown) => error);
  expect(denied).toBeUltimateError('X_FORBIDDEN');
});

${wrapper}('${name.camel} exposes one MCP tool that reads, and never writes', () => {
  // Same policy object on both surfaces — an agent cannot reach a different authz path.
  expect(target.tool().policy).toBe(target.policy);
  expect(target.tool().mutates).toBe(false);
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
    { path: `${dir}/${name.kebab}.test.ts`, contents: queryTest(name, feature, live) },
  ];
}
