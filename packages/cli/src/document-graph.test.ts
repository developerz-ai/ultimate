// The question a worker asks before each import: would this module bring a component or a
// stylesheet into the process? Wrong toward `true` leaves out a module that registers something;
// wrong toward `false` only costs the import this file exists to spare.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory or a recursive delete.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { createDocumentGraph, isDocumentModule } from './document-graph';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

/** Writes `files` under a fresh root. */
async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-document-graph-'));
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

const nothingLoaded = (): boolean => false;

describe('unit · the document graph', () => {
  test('a component and a stylesheet are documents; a module is not', () => {
    expect(['a.tsx', 'a.jsx', 'a.module.scss', 'a.sass', 'a.css'].map(isDocumentModule)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['a.ts', 'a.json', 'tsx.ts', 'a.tsx.ts'].map(isDocumentModule)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test('a module reaches a document directly, through a barrel and through a stylesheet', async () => {
    const dir = await fixture({
      'card.tsx': 'export const Card = () => null;\n',
      'card.module.scss': '.card { display: block; }\n',
      'direct.ts': "export { Card } from './card.tsx';\n",
      'barrel.ts': "export * from './direct';\n",
      'above.ts': "import './barrel';\nexport const above = 1;\n",
      'styled.ts': "import styles from './card.module.scss';\nexport const s = styles;\n",
      'plain.ts': "import { helper } from './helper';\nexport const plain = helper;\n",
      'helper.ts': 'export const helper = 1;\n',
    });
    const graph = createDocumentGraph(nothingLoaded);
    const asked = ['card.tsx', 'direct.ts', 'barrel.ts', 'above.ts', 'styled.ts', 'plain.ts'];
    const answers: boolean[] = [];
    for (const file of asked) answers.push(await graph.reachesDocument(join(dir, file)));
    expect(answers).toEqual([true, true, true, true, true, false]);
  });

  test('a type-only import and a lazy import are not edges', async () => {
    const dir = await fixture({
      'card.tsx':
        'export interface Props { readonly a: string }\nexport const Card = () => null;\n',
      'types.ts': "import type { Props } from './card.tsx';\nexport const p = (x: Props) => x;\n",
      'lazy.ts': "export const load = () => import('./card.tsx');\n",
    });
    const graph = createDocumentGraph(nothingLoaded);
    expect(await graph.reachesDocument(join(dir, 'types.ts'))).toBe(false);
    expect(await graph.reachesDocument(join(dir, 'lazy.ts'))).toBe(false);
  });

  test('every module of an import cycle that reaches a document says so', async () => {
    const dir = await fixture({
      'card.tsx': 'export const Card = () => null;\n',
      'a.ts': "import './b';\nimport './card.tsx';\nexport const a = 1;\n",
      'b.ts': "import './a';\nexport const b = 1;\n",
    });
    // `b` first: its only path to the component runs back through `a`.
    const graph = createDocumentGraph(nothingLoaded);
    expect(await graph.reachesDocument(join(dir, 'b.ts'))).toBe(true);
    expect(await graph.reachesDocument(join(dir, 'a.ts'))).toBe(true);
  });

  test('a module visited on the way to a document is not itself condemned', async () => {
    const dir = await fixture({
      'card.tsx': 'export const Card = () => null;\n',
      // The walk takes the last import first: `clean` is visited before the component is found.
      'page.ts': "import './card.tsx';\nimport './clean';\nexport const page = 1;\n",
      'clean.ts': 'export const clean = 1;\n',
    });
    const graph = createDocumentGraph(nothingLoaded);
    expect(await graph.reachesDocument(join(dir, 'page.ts'))).toBe(true);
    expect(await graph.reachesDocument(join(dir, 'clean.ts'))).toBe(false);
  });

  test('a document already in the process, and everything behind a loaded module, costs nothing', async () => {
    const dir = await fixture({
      'card.tsx': 'export const Card = () => null;\n',
      'loaded.ts': "import './card.tsx';\nexport const loaded = 1;\n",
      'above.ts': "import './loaded';\nexport const above = 1;\n",
      'direct.ts': "import './card.tsx';\nexport const direct = 1;\n",
    });
    const viaModule = createDocumentGraph((path) => path === join(dir, 'loaded.ts'));
    expect(await viaModule.reachesDocument(join(dir, 'above.ts'))).toBe(false);
    expect(await viaModule.reachesDocument(join(dir, 'direct.ts'))).toBe(true);
    const viaDocument = createDocumentGraph((path) => path === join(dir, 'card.tsx'));
    expect(await viaDocument.reachesDocument(join(dir, 'direct.ts'))).toBe(false);
  });

  test('a specifier that will not resolve and a file that will not parse are no edge', async () => {
    const dir = await fixture({
      'missing.ts': "import './not-there';\nimport 'no-such-package';\nexport const m = 1;\n",
      'broken.ts': 'export const = {{{\n',
    });
    const graph = createDocumentGraph(nothingLoaded);
    expect(await graph.reachesDocument(join(dir, 'missing.ts'))).toBe(false);
    expect(await graph.reachesDocument(join(dir, 'broken.ts'))).toBe(false);
    expect(await graph.reachesDocument(join(dir, 'never-written.ts'))).toBe(false);
  });

  test('a framework package is walked under either linker; a third-party package is not', async () => {
    // Its own `node_modules`, never the CLI's: the two packages below exist only here.
    root = mkdtempSync(join(tmpdir(), 'x-document-graph-'));
    const dir = root;
    const hoisted = 'node_modules/@ultimat3/fixture-ui';
    const isolated =
      'node_modules/.bun/@ultimat3+fixture-kit@1.0.0/node_modules/@ultimat3/fixture-kit';
    const files: Readonly<Record<string, string>> = {
      [`${hoisted}/package.json`]: '{ "name": "@ultimat3/fixture-ui", "exports": "./index.ts" }',
      [`${hoisted}/index.ts`]: "export { Button } from './button.tsx';\n",
      [`${hoisted}/button.tsx`]: 'export const Button = () => null;\n',
      [`${isolated}/package.json`]: '{ "name": "@ultimat3/fixture-kit", "exports": "./index.ts" }',
      [`${isolated}/index.ts`]: "import './kit.module.scss';\nexport const kit = 1;\n",
      [`${isolated}/kit.module.scss`]: '.kit { display: block; }\n',
      'node_modules/vendor-widgets/package.json':
        '{ "name": "vendor-widgets", "exports": "./index.ts" }',
      'node_modules/vendor-widgets/index.ts': "export { Widget } from './widget.tsx';\n",
      'node_modules/vendor-widgets/widget.tsx': 'export const Widget = () => null;\n',
      'hoisted.ts': "import { Button } from '@ultimat3/fixture-ui';\nexport const b = Button;\n",
      'isolated.ts': `import { kit } from './${isolated}/index.ts';\nexport const k = kit;\n`,
      'vendor.ts': "import { Widget } from 'vendor-widgets';\nexport const w = Widget;\n",
    };
    for (const [path, source] of Object.entries(files)) await Bun.write(join(dir, path), source);
    const graph = createDocumentGraph(nothingLoaded);
    expect(await graph.reachesDocument(join(dir, 'hoisted.ts'))).toBe(true);
    expect(await graph.reachesDocument(join(dir, 'isolated.ts'))).toBe(true);
    expect(await graph.reachesDocument(join(dir, 'vendor.ts'))).toBe(false);
  });
});
