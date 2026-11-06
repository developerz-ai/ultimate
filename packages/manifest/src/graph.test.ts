// The app graph, pure: each declared edge kind from a manifest, import and declared-in edges from
// module facts, impact as a transitive walk over dependents, a deleted edge changing the answer,
// an opaque file always in, and a path explained or answered "none known".

import { describe, expect, test } from 'bun:test';
import { buildManifest } from './build';
import { fixtureAction, fixtureQuery } from './diff-fixture';
import type { ModuleFacts } from './graph';
import { buildGraph, findNode, impactOf, pathBetween } from './graph';

const manifest = buildManifest({
  app: { name: 'acme', version: '1.0.0' },
  actions: [{ ...fixtureAction('publishPost', 'post:publish'), cacheInvalidates: ['feed'] }],
  queries: [{ ...fixtureQuery('postById', 'post:read'), cacheTags: ['feed'] }],
  routes: [{ url: '/posts', render: 'ssr', revalidateTags: ['feed'], budget: { js: '40kb' } }],
  entities: [
    { name: 'org', table: 'orgs', columns: [], invariants: [] },
    {
      name: 'post',
      table: 'posts',
      columns: [{ name: 'org_id', type: 'uuid', nullable: false, references: 'orgs.id' }],
      invariants: [],
    },
  ],
  jobs: [
    {
      name: 'notify',
      input: {},
      queue: 'default',
      retry: { attempts: 3, backoff: 'exp' },
      steps: [],
    },
  ],
  tasks: [{ name: 'nightly', cron: '0 3 * * *', tz: 'UTC', enqueues: ['notify'] }],
});

const MODULES: ModuleFacts = {
  files: [
    { path: 'app/posts/page.tsx', imports: ['app/posts/queries.ts'], opaque: false, test: false },
    { path: 'app/posts/queries.ts', imports: ['app/posts/entity.ts'], opaque: false, test: false },
    { path: 'app/posts/entity.ts', imports: [], opaque: false, test: false },
    { path: 'app/posts/actions.ts', imports: ['app/posts/entity.ts'], opaque: false, test: false },
    {
      path: 'app/posts/queries.test.ts',
      imports: ['app/posts/queries.ts'],
      opaque: false,
      test: true,
    },
    { path: 'app/other.test.ts', imports: [], opaque: false, test: true },
  ],
  primitives: [
    { kind: 'route', name: '/posts', file: 'app/posts/page.tsx' },
    { kind: 'query', name: 'postById', file: 'app/posts/queries.ts' },
    { kind: 'action', name: 'publishPost', file: 'app/posts/actions.ts' },
    { kind: 'entity', name: 'post', file: 'app/posts/entity.ts' },
  ],
};

const graph = buildGraph(manifest, MODULES);
const has = (from: string, to: string, rel: string): boolean =>
  graph.edges.some((e) => e.from === from && e.to === to && e.rel === rel);

describe('unit · buildGraph', () => {
  test('every declared edge kind', () => {
    expect(has('action:publishPost', 'permission:post:publish', 'requires')).toBe(true);
    expect(has('action:publishPost', 'tag:feed', 'invalidates')).toBe(true);
    expect(has('mcpTool:publishPost', 'action:publishPost', 'exposes')).toBe(true);
    expect(has('operation:postById', 'query:postById', 'publishes')).toBe(true);
    expect(has('query:postById', 'tag:feed', 'reads-tag')).toBe(true);
    expect(has('route:/posts', 'tag:feed', 'revalidates')).toBe(true);
    expect(has('entity:post', 'entity:org', 'references')).toBe(true);
    expect(has('task:nightly', 'job:notify', 'enqueues')).toBe(true);
    expect(
      graph.edges.filter((e) => e.rel === 'requires').every((e) => e.provenance === 'declared'),
    ).toBe(true);
  });

  test('module edges: imports, a test file, and the file a primitive is declared in', () => {
    expect(has('file:app/posts/page.tsx', 'file:app/posts/queries.ts', 'imports')).toBe(true);
    expect(has('test:app/posts/queries.test.ts', 'file:app/posts/queries.ts', 'imports')).toBe(
      true,
    );
    expect(has('query:postById', 'file:app/posts/queries.ts', 'declared-in')).toBe(true);
  });
});

describe('unit · impactOf', () => {
  test('editing a query names its route, its operation and its test — each with provenance', () => {
    const impact = impactOf(graph, 'query:postById');
    expect(impact.routes.map((r) => r.id)).toEqual(['route:/posts']);
    expect(impact.routes[0]?.provenance).toEqual(['import']);
    expect(impact.publishedOperations.map((o) => o.id)).toEqual(['operation:postById']);
    expect(impact.publishedOperations[0]?.provenance).toEqual(['declared']);
    expect(impact.tests.map((t) => t.id)).toEqual(['test:app/posts/queries.test.ts']);
    expect(impact.budgets.map((r) => r.id)).toEqual(['route:/posts']);
  });

  test('impact is transitive: an entity reaches the route through the query that imports it', () => {
    const impact = impactOf(graph, 'entity:post');
    expect(impact.routes.map((r) => r.id)).toEqual(['route:/posts']);
    expect(impact.actions.map((a) => a.id)).toEqual(['action:publishPost']);
    expect(impact.mcpTools.map((m) => m.id)).toEqual(['mcpTool:publishPost']);
    expect(impact.tests.map((t) => t.id)).toEqual(['test:app/posts/queries.test.ts']);
  });

  test('a deleted edge changes the answer', () => {
    const cut: ModuleFacts = {
      ...MODULES,
      files: MODULES.files.map((f) =>
        f.path === 'app/posts/page.tsx' ? { ...f, imports: [] } : f,
      ),
    };
    expect(impactOf(buildGraph(manifest, cut), 'query:postById').routes).toEqual([]);
  });

  test('an opaque file and its dependents are always in, whatever changed', () => {
    const opaque: ModuleFacts = {
      ...MODULES,
      files: MODULES.files.map((f) =>
        f.path === 'app/other.test.ts' ? { ...f, opaque: true } : f,
      ),
    };
    const impact = impactOf(buildGraph(manifest, opaque), 'entity:org');
    expect(impact.tests.map((t) => t.id)).toContain('test:app/other.test.ts');
    expect(impact.opaque).toEqual(['test:app/other.test.ts']);
  });
});

describe('unit · pathBetween and findNode', () => {
  test('a path is the chain of edges; none known says what was searched', () => {
    const path = pathBetween(graph, 'route:/posts', 'entity:post');
    expect(path.edges?.map((e) => e.rel)).toEqual([
      'declared-in',
      'imports',
      'imports',
      'declared-in',
    ]);
    const none = pathBetween(graph, 'task:nightly', 'entity:org');
    expect(none.edges).toBeNull();
    expect(none.searched).toEqual(['declared', 'import']);
  });

  test('a name, an id or a path finds its node; a miss lists the nearest three', () => {
    expect(findNode(graph, 'postById').id).toBe('query:postById');
    expect(findNode(graph, 'app/posts/page.tsx').id).toBe('file:app/posts/page.tsx');
    const miss = findNode(graph, 'postByld');
    expect(miss.id).toBeUndefined();
    expect(miss.candidates).toHaveLength(3);
    expect(miss.candidates[0]).toBe('query:postById');
  });
});
