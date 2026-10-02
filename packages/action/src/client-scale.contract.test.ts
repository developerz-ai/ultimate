// The typed client at app scale, compiled by the real `tsc` the way an app's own gate compiles it:
// 300 `action()` declarations in 100 modules and 100 `query()` declarations in 50, handed to
// `defineApi` as `import * as` namespaces, then `rpc<Api['actions']>` and
// `queryClient<Api['queries']>` and one call of each.
//
// `client-scale-pins.ts` holds the same claim inside `tsc -b`; this is the half it cannot reach —
// `defineApi`'s `const` inference over real module namespaces, and `@ultimat3/query`'s client
// over the map this package merges. The shape is the OBSERVED one (#534): what broke was the
// number of MODULES in one list — 47 compiled, 48 was TS2589 — never the number of actions.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no API for creating or removing a temporary directory (`mkdtempSync`, `rmSync`).
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path joiner; `Bun.write` and `Bun.spawn` take a path already joined.
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const ACTION_MODULES = 100;
const ACTIONS_PER_MODULE = ['create', 'update', 'archive'] as const;
const QUERY_MODULES = 50;

const actionModule = (index: number): string => `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
${ACTIONS_PER_MODULE.map(
  (verb) => `
export const ${verb}Thing${index} = action({
  input: t.object({
    id: t.uuid,
    title: t.string.min(1).max(80),
    tags: t.array(t.string),
    count: t.number.int().min(0).default(0),
    nested: t.object({ label: t.string, on: t.boolean.default(true), kind: t.enumerated('x', 'y') }),
  }),
  output: t.object({ id: t.uuid, items: t.array(t.object({ sku: t.string })), m${index}: t.string.nullable() }),
  policy: allow(),
  handle: ({ input }) => ({ id: input.id, items: [], m${index}: null }),
});`,
).join('\n')}

/** Not an action: a feature module exports its own helpers beside its primitives. */
export const helper${index} = (value: number): number => value + 1;
`;

const queryModule = (index: number): string => `import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';

interface Row${index} { readonly id: string; readonly n${index}: number }

export const listRows${index} = query({
  input: t.object({ orgId: t.uuid, limit: t.number.int().min(1).max(50).default(50) }),
  policy: allow(),
  sql: ({ orgId, limit }) => from<Row${index}>('rows', () => []).where({ orgId }).orderBy('id').limit(limit),
});

export const oneRow${index} = query({
  input: t.object({ orgId: t.uuid, id: t.uuid }),
  policy: allow(),
  single: true,
  sql: ({ orgId, id }) => from<Row${index}>('rows', () => []).where({ orgId, id }).orderBy('id').limit(1),
});
`;

const list = (count: number, name: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => name(index)).join(', ');

const apiModule = (): string => `import { defineApi } from '@ultimat3/action';
${Array.from({ length: ACTION_MODULES }, (_, i) => `import * as a${i} from './actions-${i}';`).join('\n')}
${Array.from({ length: QUERY_MODULES }, (_, i) => `import * as q${i} from './queries-${i}';`).join('\n')}

export const api = defineApi({
  actions: [${list(ACTION_MODULES, (i) => `a${i}`)}],
  queries: [${list(QUERY_MODULES, (i) => `q${i}`)}],
});
export type Api = typeof api;
`;

const LAST_ACTION = ACTION_MODULES - 1;
const LAST_QUERY = QUERY_MODULES - 1;

const clientModule = (): string => `import { rpc } from '@ultimat3/action';
import { queryClient } from '@ultimat3/query';
import type { Api } from './api';

export const client = rpc<Api['actions']>({ baseUrl: '' });
export const queries = queryClient<Api['queries']>({ baseUrl: '' });

export const written: Promise<{ id: string; m${LAST_ACTION}: string | null }> =
  client.archiveThing${LAST_ACTION}({ id: 'i', title: 't', tags: [], nested: { label: 'l', kind: 'x' } });
export const rows: Promise<readonly { readonly n${LAST_QUERY}: number }[]> =
  queries.listRows${LAST_QUERY}({ orgId: 'o' });
export const page = queries.listRows${LAST_QUERY}.page({ orgId: 'o' }, { first: 10 });
export const row: Promise<{ readonly n${LAST_QUERY}: number }> = queries.oneRow${LAST_QUERY}({ orgId: 'o', id: 'i' });

// @ts-expect-error a helper exported beside the actions is not a client method
client.helper0;
// @ts-expect-error a name nothing registered is a compile error, not a 404
client.archiveThing${ACTION_MODULES};
// @ts-expect-error the input is the action's own schema
client.createThing0({ id: 'i' });
`;

const tsconfig = (): string =>
  JSON.stringify({
    extends: join(ROOT, 'tsconfig.base.json'),
    compilerOptions: {
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      typeRoots: [join(ROOT, 'node_modules', '@types')],
      types: ['bun'],
    },
    include: ['./*.ts'],
  });

const dir = mkdtempSync(join(tmpdir(), 'x-client-scale-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function compile(): Promise<string> {
  const files: [string, string][] = [
    ['api.ts', apiModule()],
    ['client.ts', clientModule()],
    ['tsconfig.json', tsconfig()],
  ];
  for (let index = 0; index < ACTION_MODULES; index++) {
    files.push([`actions-${index}.ts`, actionModule(index)]);
  }
  for (let index = 0; index < QUERY_MODULES; index++) {
    files.push([`queries-${index}.ts`, queryModule(index)]);
  }
  await Promise.all(files.map(([name, contents]) => Bun.write(join(dir, name), contents)));
  const tsc = Bun.spawn(
    [join(ROOT, 'node_modules', '.bin', 'tsc'), '--pretty', 'false', '-p', 'tsconfig.json'],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(tsc.stdout).text(),
    new Response(tsc.stderr).text(),
    tsc.exited,
  ]);
  // The fixture's own files, plus a diagnostic naming no file (`error TS5083`: the project never
  // compiled, which must not read as a pass). One in a workspace package is that package's gate.
  return `${stdout}\n${stderr}`
    .split('\n')
    .filter((line) => /^((api|client|actions-\d+|queries-\d+)\.ts\(|error TS)/.test(line))
    .join('\n');
}

describe('contract · the typed client at 300 actions and 100 queries', () => {
  test('the fixture is the shape that broke: more modules in one list than the old limit of 47', () => {
    expect(ACTION_MODULES * ACTIONS_PER_MODULE.length).toBe(300);
    expect(QUERY_MODULES * 2).toBe(100);
    expect(Math.min(ACTION_MODULES, QUERY_MODULES)).toBeGreaterThan(47);
  });

  test("rpc<Api['actions']>, queryClient<Api['queries']> and one call of each compile", async () => {
    // The diagnostics themselves, so a red gate reads `client.ts(5,27): error TS2589: …`.
    expect(await compile()).toBe('');
  }, 120_000);
});
