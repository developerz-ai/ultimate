// The scaffolded app icon is the one source `@ultimat3/pwa` derives every install icon from. It
// has to be bytes `@ultimat3/core`'s image pipeline can actually decode — the pipeline reads PNG
// and JPEG only — so these tests pin the shape a silent regression would otherwise break quietly:
// an app that scaffolds with an icon nothing can ever turn into `/icons/icon-192.png`.

import { describe, expect, test } from 'bun:test';
import { decodeImage, probeImage } from '@ultimat3/core';
import type { NestedCatalog } from '@ultimat3/i18n';
import { catalogKeys, defineCatalogs, loadCatalog } from '@ultimat3/i18n';
import { BuiltinImagePipeline } from '@ultimat3/pwa';
import { planNewApp } from './cmd-new';
import { icon } from './templates/scaffold-icon';
import { belongsToType } from './test-select';
import { parseVerifyFloor, VERIFY_FLOOR_FILE } from './verify-floor';

/** The scaffolded bytes, proven to be bytes — `contents` is `string | Uint8Array`. */
function iconBytes(): Uint8Array {
  const file = planNewApp({ name: 'demo-app', example: false }).find(
    (candidate) => candidate.path === 'apps/web/site/icon.png',
  );
  expect(file).toBeDefined();
  const contents = file?.contents;
  expect(contents).toBeInstanceOf(Uint8Array);
  return contents instanceof Uint8Array ? contents : new Uint8Array();
}

describe('unit · x new · scaffolded icon', () => {
  test('emits apps/web/site/icon.png, never the old icon.svg', () => {
    const paths = planNewApp({ name: 'demo-app', example: false }).map((file) => file.path);
    expect(paths).toContain('apps/web/site/icon.png');
    expect(paths).not.toContain('apps/web/site/icon.svg');
  });

  // The load-bearing assertion: this is what proves the source icon is decodable by the pipeline
  // that @ultimat3/pwa feeds it through — a byte-for-byte guarantee `.svg` could never make.
  test('the icon is a real, pipeline-decodable 1024x1024 PNG', () => {
    const info = probeImage(iconBytes());
    expect(info.format).toBe('png');
    expect(info.width).toBe(1024);
    expect(info.height).toBe(1024);
  });

  // The end of the chain: scaffolded source -> pwa's pipeline -> the exact PNG the generated web
  // manifest names. A source the pipeline cannot decode fails here, not on an install nobody watches.
  test('the icon bytes survive a BuiltinImagePipeline resize to 192x192', async () => {
    const png = await new BuiltinImagePipeline().resize(iconBytes(), { size: 192, padding: 0.1 });
    expect(probeImage(png)).toMatchObject({ format: 'png', width: 192, height: 192 });
  });

  test('icon() is deterministic: the same bytes on every call', () => {
    expect(icon()).toEqual(icon());
  });

  // Enforced rather than commented (axiom 3). The CLI cannot reach `@ultimat3/ui`'s colour roles —
  // both are tier 5 — so the one honest placeholder is no colour at all: a grey level on all three
  // channels. A palette value pasted in here fails this test instead of surviving to a review.
  test('the mark is greyscale on a transparent canvas — no palette value to drift from', () => {
    const raster = decodeImage(iconBytes());
    const at = (x: number, y: number): readonly number[] => {
      const i = (y * raster.width + x) * 4;
      return [...raster.pixels.slice(i, i + 4)];
    };

    const [r, g, b, a] = at(raster.width / 2, raster.height / 2);
    expect([g, b]).toEqual([r, r]);
    expect(a).toBe(255);
    // The maskable safe zone stops short of the edge, so the corner is canvas, not mark.
    expect(at(0, 0)[3]).toBe(0);
  });
});

/** The scaffolded catalog for one variant, as a string — `contents` is `string | Uint8Array`. */
function catalogSource(example: boolean): string {
  const file = planNewApp({ name: 'demo-app', example }).find(
    (candidate) => candidate.path === 'packages/i18n/catalogs/en.json',
  );
  const contents = file?.contents;
  expect(typeof contents).toBe('string');
  return typeof contents === 'string' ? contents : '';
}

describe('unit · x new · scaffolded catalog', () => {
  // The catalog `x new` writes is the one `defineCatalogs` loads at the app's first boot. When it
  // was authored flat (`"site.home.title"`), that boot threw X_CATALOG_INVALID — a dot is not a
  // key segment — and nothing here noticed, because every assertion read the JSON directly rather
  // than through the loader. These go through the loader.
  for (const example of [false, true]) {
    test(`--${example ? 'example' : 'no-example'} scaffolds a catalog defineCatalogs accepts`, () => {
      const en = JSON.parse(catalogSource(example)) as unknown;
      const catalogs = defineCatalogs({ default: 'en', locales: { en: en as NestedCatalog } });
      expect(catalogKeys(catalogs.catalogs.en ?? {})).toContain('site.home.title');
    });
  }

  test('the example slice and the scaffold both land in it, under the same top-level key', () => {
    const keys = catalogKeys(loadCatalog(JSON.parse(catalogSource(true))));
    expect(keys).toContain('app.dashboard.title');
    expect(keys).toContain('app.post.empty');
  });
});

/** One emitted file's text, whichever variant wrote it — `contents` is `string | Uint8Array`. */
function emitted(path: string, example: boolean): string {
  const file = planNewApp({ name: 'demo-app', example }).find(
    (candidate) => candidate.path === path,
  );
  const contents = file?.contents;
  expect(typeof contents).toBe('string');
  return typeof contents === 'string' ? contents : '';
}

describe('unit · x new · the suite floor the app is gated on', () => {
  // `X_VERIFY_SUITE_VANISHED` was unreachable in every generated app: no scaffold wrote a floor,
  // `readVerifyFloor` answers "no file is no floor", and a deleted suite turns its step from green
  // into skipped-and-green. The scaffold has to commit the claim, because it is the only party
  // that knows which steps the app it just wrote can actually run.
  for (const example of [false, true]) {
    test(`--${example ? 'example' : 'no-example'} writes a floor of steps the gate runs`, () => {
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      expect(floor.problems).toEqual([]);
      expect(floor.steps).toContain('unit');
      expect(floor.steps).toContain('typecheck');
      expect(floor.steps).toContain('manifest');
    });

    // Derived, not restated: a floor naming a suite the scaffold ships no file for pins a step
    // that can never apply, which holds the app's first gate red forever. `eval` is not in the
    // list because it is the one step that applies with no suite of its own — every prompt must
    // have an eval, and an app with neither still has that question answered.
    test(`--${example ? 'example' : 'no-example'} names no typed suite it ships no file for`, () => {
      const files = planNewApp({ name: 'demo-app', example });
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      for (const type of ['contract', 'live', 'job', 'e2e'] as const) {
        if (!floor.steps.includes(type)) continue;
        expect(files.some((file) => belongsToType(file.path, type))).toBe(true);
      }
    });
  }

  // `e2eTest` is `test.skip` until an app registers a browser driver, so the scaffolded
  // `page.e2e.test.ts` runs zero tests — a floor naming `e2e` would fail `x verify` on the
  // scaffold's own placeholder rather than on anything the author did.
  test('it does not pin e2e, whose scaffolded test skips itself until a driver exists', () => {
    expect(parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, true)).steps).not.toContain('e2e');
  });
});
