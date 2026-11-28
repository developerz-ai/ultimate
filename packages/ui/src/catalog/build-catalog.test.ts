// The catalog builder walks a PACKAGE ROOT, so `@ultimat3/effects` generates its CATALOG.md with
// the same walk `@ultimat3/ui` does — and ui's own page must not move by a byte for it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  buildCatalog,
  CATALOG_PATH,
  catalogFromArgs,
  collectComponents,
  UI_ROOT,
} from './build-catalog';

const root = mkdtempSync(join(tmpdir(), 'x-catalog-root-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WIDGET = `// A widget.

import type { JSX } from 'solid-js';

export interface WidgetProps {
  label: string;
}

export function Widget(props: WidgetProps): JSX.Element {
  return props.label;
}
`;

describe('build-catalog takes a package root', () => {
  test('the default root is ui, and the committed page is still what it renders', async () => {
    expect(UI_ROOT).toBe(join(import.meta.dir, '..', '..'));
    expect(CATALOG_PATH).toBe(join(UI_ROOT, 'CATALOG.md'));
    expect(await Bun.file(CATALOG_PATH).text()).toBe(await buildCatalog());
    expect((await collectComponents(UI_ROOT)).map((doc) => doc.name)).toEqual(
      (await collectComponents()).map((doc) => doc.name),
    );
  });

  test('another root is walked by its own pattern, alphabetically by file', async () => {
    await Bun.write(join(root, 'src', 'zeta', 'Widget.tsx'), WIDGET);
    await Bun.write(
      join(root, 'src', 'alpha', 'Gadget.tsx'),
      WIDGET.replaceAll('Widget', 'Gadget'),
    );
    await Bun.write(join(root, 'src', 'alpha', 'gadget-view.ts'), 'export const x = 1;\n');
    const docs = await collectComponents(root, 'src/*/[A-Z]*.tsx');
    expect(docs.map((doc) => doc.name)).toEqual(['Gadget', 'Widget']);
    expect(docs[0]?.summary).toBe('A widget.');
  });
});

describe('the command line: `bun run catalog [<root> <glob> [<title>]]`', () => {
  test('no argument is ui’s own page, byte for byte', async () => {
    expect(await catalogFromArgs([])).toEqual({
      path: CATALOG_PATH,
      text: await Bun.file(CATALOG_PATH).text(),
    });
  });

  test('a title renders that package’s components-only page at its root', async () => {
    await Bun.write(join(root, 'src', 'zeta', 'Widget.tsx'), WIDGET);
    const page = await catalogFromArgs([root, 'src/*/[A-Z]*.tsx', '@ultimat3/effects']);
    expect(page.path).toBe(join(root, 'CATALOG.md'));
    expect(page.text).toContain('# @ultimat3/effects catalog\n');
    expect(page.text).toContain('### Widget');
    expect(page.text).not.toContain('## Tokens');
  });
});
