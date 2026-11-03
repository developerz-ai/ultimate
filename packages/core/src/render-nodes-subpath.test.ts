// `@ultimat3/core/render-nodes` and its leaf `@ultimat3/core/render-node` stay OFF the barrel and
// off every shipped bundle graph: the walker is test-only by its callers, and the leaf holds one
// `Symbol.for`, imported by `@ultimat3/render` so the brand is spelt once (axiom 6).

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path API; the scan is rooted at the repository this file sits in.
import { join, resolve } from 'node:path';
import * as barrel from './index';

const REPO = resolve(import.meta.dir, '..', '..', '..');
const WALKER_NAMES = [
  'JSX_NODE',
  'ISLAND_NODE',
  'HOLE_NODE',
  'isRenderNode',
  'nodesOf',
  'renderNodes',
  'byTag',
  'byComponent',
  'withAttr',
  'one',
  'attachRef',
  'fire',
];

/** The places source lives: every package's `src/` and both tracked apps' workspaces. */
const ROOTS = [
  'packages/*/src/**/*.{ts,tsx}',
  'examples/dummy/{apps,packages}/**/*.{ts,tsx}',
  'dummy/social-media-clone/{apps,packages}/**/*.{ts,tsx}',
];

const isTestOnly = (path: string): boolean =>
  /\.test\.tsx?$/.test(path) || /-fixture\.tsx?$/.test(path);

async function sources(): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of ROOTS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: REPO })) {
      if (!path.includes('node_modules') && !path.includes('/dist/')) found.push(path);
    }
  }
  return found;
}

describe('the render-nodes subpaths', () => {
  test('both are published subpaths of the package', async () => {
    const pkg: unknown = await Bun.file(join(import.meta.dir, '..', 'package.json')).json();
    expect(pkg).toMatchObject({
      exports: {
        './render-node': './src/render-node.ts',
        './render-nodes': './src/render-nodes.ts',
      },
    });
  });

  test('the barrel holds none of their names', () => {
    for (const name of WALKER_NAMES) expect(Object.keys(barrel)).not.toContain(name);
  });

  test('the leaf imports nothing, and is the one spelling of each brand in core', async () => {
    const leaf = await Bun.file(join(import.meta.dir, 'render-node.ts')).text();
    expect(leaf).not.toMatch(/^\s*(import|export .* from)\b/m);
    expect(leaf).toContain("Symbol.for('ultimate.render.jsx')");
  });

  test('render resolves every brand through the leaf and spells no copy of its own', async () => {
    const jsx = await Bun.file(join(REPO, 'packages/render/src/jsx.ts')).text();
    expect(jsx).toContain("from '@ultimat3/core/render-node'");
    expect(jsx).not.toContain('ultimate.render.jsx');
    const island = await Bun.file(join(REPO, 'packages/render/src/island.ts')).text();
    expect(island).toContain("from '@ultimat3/core/render-node'");
    expect(island).not.toContain('ultimate.render.island');
    const hole = await Bun.file(join(REPO, 'packages/render/src/hole.ts')).text();
    expect(hole).toContain("from '@ultimat3/core/render-node'");
    expect(hole).not.toContain('ultimate.render.hole');
  });

  test('render-nodes is imported by no source that ships', async () => {
    const importers: string[] = [];
    for (const path of await sources()) {
      if (isTestOnly(path)) continue;
      const text = await Bun.file(join(REPO, path)).text();
      if (/['"](@ultimat3\/core\/render-nodes|\.\/render-nodes)['"]/.test(text))
        importers.push(path);
    }
    expect(importers).toEqual([]);
  });
});
