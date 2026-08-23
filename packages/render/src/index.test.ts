// The CLIENT barrel, and the one property that makes it one: it re-exports the authoring
// vocabulary and it cannot REACH the build-time half. `packages/render/src/css-modules.ts` imports
// `node:url`, whose browser polyfill exports neither name it asks for, so a single import edge from
// here is not a slower bundle — it is a `bun build --target=browser` that fails outright, which is
// what shipped until the `"."` / `"./server"` split.
//
// The end property is asserted in `scripts/browser-barrel.test.ts`, which builds this file for the
// browser. What is asserted HERE is the mechanism, because a bundler's tree-shake is discretion and
// an import graph is a fact: measured, no `sideEffects` value fixes that build (`false`, `[]`, and
// an array naming only `errors.ts` all fail identically), because the failure is at link time.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as barrel from './index';
import * as serverBarrel from './server';

/** The build-time half, by module. Each one is unreachable from `index.ts` at RUNTIME. */
const BUILD_TIME_MODULES = [
  'css-modules',
  'module-loader',
  'render-html',
  'render-isr',
  'render-ssr',
  'render-static',
  'render-stream',
] as const;

const scanner = new Bun.Transpiler({ loader: 'ts' });

/**
 * Every module a barrel reaches through RELATIVE specifiers, transitively. `scanImports` reports
 * the runtime graph only — an `export type { … } from './render-isr'` is erased and is correctly
 * absent, which is the same distinction the bundler makes.
 */
function reachable(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const source = readFileSync(join(import.meta.dir, `${name}.ts`), 'utf8');
    for (const found of scanner.scanImports(source)) {
      if (found.path.startsWith('./')) queue.push(found.path.slice(2));
    }
  }
  seen.delete(entry);
  return seen;
}

describe('the two barrels are disjoint', () => {
  test('no name is exported by both, so which half a symbol lives in is decidable', () => {
    const client = new Set(Object.keys(barrel));
    const shared = Object.keys(serverBarrel).filter((name) => client.has(name));
    // A name on both barrels is an app choosing an import at random and a bundler resolving one of
    // them — the ambiguity axiom 1 exists to refuse, and the reason `./server` re-exports nothing
    // from here rather than "the client half plus the server extras".
    expect(shared).toEqual([]);
  });

  test('and neither is accidentally empty, which would satisfy the line above vacuously', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(40);
    expect(Object.keys(serverBarrel).length).toBeGreaterThan(20);
  });
});

describe('the client barrel cannot reach the build-time half', () => {
  test('no build-time module is in its runtime import graph', () => {
    const graph = reachable('index');
    expect([...BUILD_TIME_MODULES].filter((name) => graph.has(name))).toEqual([]);
    // Non-vacuous: the graph is a real one, not an empty set from a scan that read nothing.
    expect(graph.has('route')).toBe(true);
    expect(graph.has('jsx')).toBe(true);
  });

  test('and the server barrel reaches every one of them — the same scan, the other answer', () => {
    const graph = reachable('server');
    expect([...BUILD_TIME_MODULES].filter((name) => !graph.has(name))).toEqual([]);
  });
});

describe('the barrel re-exports the modules themselves, never copies', () => {
  test('the route primitive and the JSX factory are the same objects', async () => {
    const route = await import('./route');
    const jsx = await import('./jsx');
    // Identity matters here and is not pedantry: `h` is what the LOADER's prelude imports from
    // this package, so a barrel handing back a wrapper would give a route file a factory that
    // builds nodes `isJsxNode` does not recognise.
    expect(barrel.defineRoute).toBe(route.defineRoute);
    expect(barrel.h).toBe(jsx.h);
    expect(barrel.Fragment).toBe(jsx.Fragment);
    expect(barrel.isJsxNode).toBe(jsx.isJsxNode);
    expect(barrel.JSX_NODE).toBe(jsx.JSX_NODE);
  });

  test('the registry and the island primitive are the same objects', async () => {
    const registry = await import('./registry');
    const island = await import('./island');
    expect(barrel.registerRoute).toBe(registry.registerRoute);
    expect(barrel.describeRoutes).toBe(registry.describeRoutes);
    expect(barrel.routeFor).toBe(registry.routeFor);
    // `matchRoute` is deleted, not renamed: two exported pattern matchers with different
    // precedence rules is two answers to "which route is this?", and `@ultimat3/http`'s trie
    // (`stages.ts`) is the one with callers. `routeFor` above is an exact-path lookup, not a
    // second matcher.
    expect(Object.keys(barrel)).not.toContain('matchRoute');
    expect(barrel.island).toBe(island.island);
  });

  test('the head renderer the wiki tells callers to use is present and is head.ts’s', async () => {
    // `wiki/Known-Gaps.md` names this pair as the ONE supported way to render a head, after
    // `@ultimat3/seo`'s weaker serializer was removed in 2.0.0.
    const head = await import('./head');
    expect(barrel.renderHead).toBe(head.renderHead);
    expect(barrel.headFromMeta).toBe(head.headFromMeta);
  });

  test('nothing is exported as undefined — a re-export of a renamed symbol is silent', () => {
    // A `export { gone } from './x'` where `x` no longer exports `gone` is a build error, but a
    // barrel entry that resolves to `undefined` (a renamed const, a type/value mix-up) is not.
    const holes = Object.entries(barrel as Record<string, unknown>)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(holes).toEqual([]);
  });
});
