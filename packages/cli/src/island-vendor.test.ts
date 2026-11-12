// Solid as one shared output, against real `Bun.build`s of two islands no route renders together:
// with `vendorSolid` both import `vendor-solid.<hash>.js` and neither inlines Solid; off (the
// default) each is self-contained, byte for byte what it was.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { contentHash } from '@ultimat3/render/server';
import { mountIsland } from '@ultimat3/testing';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { groupKey } from './island-group-cache';
import { clearIslandChunkCache } from './island-identity';
import { isVendorChunk, VENDOR_SPECIFIER } from './island-vendor';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'vendor-solid'));

/** Solid's reactive core, by a symbol description its minified production build keeps verbatim. */
const SOLID_INTERNAL = 'Symbol("solid-track")';

const counter = (label: string): string => `
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
export function mount(el: HTMLElement): () => void {
  const [count] = createSignal(0);
  return render(() => '${label}' + String(count()), el);
}
`;
const PLAIN = `export function mount(el: { textContent: string }): void { el.textContent = 'plain'; }\n`;

let on: IslandBundle;
let off: IslandBundle;

beforeAll(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'vendor-solid-fixture' }));
  await Bun.write(join(ROOT, 'apps/web/app/one/first.island.tsx'), counter('first'));
  await Bun.write(join(ROOT, 'apps/web/app/two/second.island.tsx'), counter('second'));
  await Bun.write(join(ROOT, 'apps/web/app/three/plain.island.tsx'), PLAIN);
  on = await buildIslands(ROOT, { reuse: false, vendorSolid: true });
  off = await buildIslands(ROOT, { reuse: false });
});

afterAll(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

const solidIslands = (bundle: IslandBundle) =>
  bundle.chunks.filter((chunk) => !chunk.file.endsWith('plain.island.tsx'));

describe('vendorSolid', () => {
  test('two islands built apart import one vendor file, and neither inlines Solid', () => {
    const vendors = on.shared.filter((one) => isVendorChunk(one.url));
    expect(vendors).toHaveLength(1);
    const [vendor] = vendors;
    expect(vendor?.url).toMatch(/^\/islands\/vendor-solid\.[0-9a-z]+\.js$/);
    // Named by its bytes (#1075): the name is a promise about exactly this code.
    expect(vendor?.url).toBe(`/islands/vendor-solid.${contentHash(vendor?.code ?? '')}.js`);
    expect(vendor?.code).toContain(SOLID_INTERNAL);
    expect(vendor?.importers).toEqual([
      'apps/web/app/one/first.island.tsx',
      'apps/web/app/two/second.island.tsx',
    ]);
    for (const chunk of solidIslands(on)) {
      expect(chunk.imports).toEqual([vendor?.url ?? '']);
      expect(chunk.code).toContain(`"./${vendor?.url.split('/').at(-1)}"`);
      expect(chunk.code).not.toContain(SOLID_INTERNAL);
    }
  });

  test('a page rendering both makes three script requests: two entries and the vendor', () => {
    const urls = new Set(solidIslands(on).flatMap((chunk) => [chunk.url, ...chunk.imports]));
    expect(urls.size).toBe(3);
  });

  test('an entry linked to the vendor boots: Solid renders through the shared file', async () => {
    using mounted = await mountIsland({
      build: async () => on,
      root: ROOT,
      file: 'apps/web/app/one/first.island.tsx',
    });
    expect(mounted.el.textContent).toBe('first0');
  });

  test('an island that imports no Solid loads no vendor', () => {
    const plain = on.chunks.find((chunk) => chunk.file.endsWith('plain.island.tsx'));
    expect(plain?.imports).toEqual([]);
  });

  test('the vendor exports DEV, which two star exports of one name would drop', async () => {
    const vendor = on.shared.find((one) => isVendorChunk(one.url));
    const scanned = new Bun.Transpiler({ loader: 'js' }).scan(vendor?.code ?? '');
    expect(scanned.exports).toContain('DEV');
    expect(scanned.exports).toContain('render');
    expect(scanned.exports).toContain('createStore');
  });

  test('off by default: each island carries its own tree-shaken Solid and no vendor ships', () => {
    expect(off.shared.filter((one) => isVendorChunk(one.url))).toEqual([]);
    for (const chunk of solidIslands(off)) {
      expect(chunk.imports).toEqual([]);
      expect(chunk.code).toContain(SOLID_INTERNAL);
    }
  });
});

describe('islands.vendorSolid in app.config.ts', () => {
  test('turns it on for a build that passes no option, and an option overrides it', async () => {
    const config = join(ROOT, 'app.config.ts');
    await Bun.write(
      config,
      "export const config = { name: 'vendor-solid-fixture', islands: { vendorSolid: true } };\n",
    );
    try {
      const configured = await buildIslands(ROOT, { reuse: false });
      expect(configured.shared.filter((one) => isVendorChunk(one.url))).toHaveLength(1);
      const overridden = await buildIslands(ROOT, { reuse: false, vendorSolid: false });
      expect(overridden.shared.filter((one) => isVendorChunk(one.url))).toEqual([]);
    } finally {
      await rm(config, { force: true });
    }
  }, 30_000);
});

describe('VENDOR_SPECIFIER', () => {
  test('answers solid-js, /web and /store, and leaves the rest to the island', () => {
    for (const one of ['solid-js', 'solid-js/web', 'solid-js/store']) {
      expect(VENDOR_SPECIFIER.test(one)).toBe(true);
    }
    for (const one of ['solid-js/html', 'solid-js/h', 'solid-js-extra', 'solid-js/web/x']) {
      expect(VENDOR_SPECIFIER.test(one)).toBe(false);
    }
  });

  test('isVendorChunk is the file name, never a prefix', () => {
    expect(isVendorChunk('/islands/vendor-solid.abc123.js')).toBe(true);
    expect(isVendorChunk('/islands/vendor-solid-abc123.js')).toBe(false);
    expect(isVendorChunk('/islands/vendor-solid.abc123.js.map')).toBe(false);
  });
});

describe('the group cache key', () => {
  const parts = {
    group: ['a.island.tsx'],
    splitting: false,
    environment: 'e',
    persists: undefined,
  };

  test('a vendored build is another entry; an unvendored one keeps the key it always had', () => {
    expect(groupKey({ ...parts, vendor: true })).not.toBe(groupKey(parts));
    expect(groupKey({ ...parts, vendor: false })).toBe(groupKey(parts));
  });
});
