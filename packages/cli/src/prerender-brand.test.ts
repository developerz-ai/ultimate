// The static export carries the app's brand exactly as the served process does — as the tail of the
// stylesheet the exported document links, with no inline `<style>` — and every immutable file it
// writes has the `.br`/`.gz` siblings a static host serves with no coder of its own.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets } from '@ultimat3/render/server';
import { defineTheme } from '@ultimat3/ui';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';
import { setBrandStyles } from './style-bundle';
import { APP_THEME_MODULE } from './theme-brand';

const ROOT = processRoot(join(import.meta.dir, '..', '.prerender-brand-fixture'));
const UI = join(import.meta.dir, '../../ui/src/index.ts');

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-brand-fixture', version: '1.0.0' }),
  );
  registerRoute({
    file: 'apps/web/site/page.tsx',
    config: defineRoute({
      render: 'static',
      hydrate: 'never',
      offline: 'precache',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Home', description: 'the landing page' }),
    }),
  });
});

afterEach(async () => {
  clearRoutes();
  clearStylesheets();
  setBrandStyles('');
  await rm(ROOT, { recursive: true, force: true });
});

const OUT = join(ROOT, 'static');

const exported = async (): Promise<string> => {
  await prerenderSite({ root: ROOT, out: OUT, origin: 'https://example.test' });
  return Bun.file(join(OUT, 'index.html')).text();
};

/** The file the exported document's `<link rel="stylesheet">` names, read from the export. */
const linkedSheet = async (html: string): Promise<string> => {
  const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1];
  if (href === undefined) return expect.unreachable('the exported document links no stylesheet');
  return Bun.file(join(OUT, href.slice(1))).text();
};

describe('x build --target static · the app brand', () => {
  test('the exported document links a sheet whose tail is the brand, and inlines none', async () => {
    await Bun.write(
      join(ROOT, APP_THEME_MODULE),
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    const html = await exported();
    expect(html).not.toContain('<style');
    const sheet = await linkedSheet(html);
    expect(sheet.endsWith(defineTheme({ preset: 'scifi' }).css)).toBe(true);
  });

  test('the linked sheet has .br and .gz siblings that decode to it', async () => {
    await Bun.write(
      join(ROOT, APP_THEME_MODULE),
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    const html = await exported();
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1] ?? '';
    const sheet = await linkedSheet(html);
    const path = join(OUT, href.slice(1));
    const gz = await Bun.file(`${path}.gz`).bytes();
    expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(sheet);
    expect(await Bun.file(`${path}.br`).exists()).toBe(true);
  });

  test('an app with no theme module exports no <style>', async () => {
    expect(await exported()).not.toContain('<style');
  });
});
