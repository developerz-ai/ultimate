// `asset()` from a stylesheet, through the loader every process uses: `loadApp` installs the app's
// asset table before it imports a module, so a `.module.scss` calling `asset('assets/…')` compiles
// to the same content-hashed URL `/assets/*` serves and `x build --target static` writes — in
// `x dev`, the container and the static build alike (one install, three processes).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
import { join } from 'node:path'; // why: Bun ships no path API.
import { clearStylesheets, stylesFor } from '@ultimat3/render/server';
import { loadApp } from './app-load';
import { resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';
import { siteAssetTable } from './site-assets';

const ROOT = processRoot(join(import.meta.dir, '..', '.site-assets-scss-fixture'));

beforeAll(async () => {
  resetRegistries();
  clearStylesheets();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'scss-asset-fixture' }));
  await Bun.write(join(ROOT, 'apps/web/site/assets/fonts/inter.woff2'), 'wOF2 fixture bytes');
  await Bun.write(
    join(ROOT, 'apps/web/site/fonts.scss'),
    `@font-face { font-family: Inter; src: url(asset('assets/fonts/inter.woff2')) format('woff2'); }\n`,
  );
  await Bun.write(
    join(ROOT, 'apps/web/site/page.tsx'),
    `import { defineRoute } from '@ultimat3/render';
import './fonts.scss';
export const config = defineRoute({ render: 'static', offline: 'runtime', meta: () => ({ title: 'Home', description: 'x' }) });
export function Page() { return <p>home</p>; }
`,
  );
});

afterAll(async () => {
  try {
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    clearStylesheets();
    resetRegistries();
  }
});

describe('unit · asset() in a stylesheet resolves through the app table', () => {
  test('the served CSS names the hashed URL the asset route serves', async () => {
    expect((await loadApp(ROOT)).findings).toEqual([]);
    const { url } = siteAssetTable(ROOT).resolve('assets/fonts/inter.woff2');
    expect(url).toMatch(/^\/assets\/fonts\/inter\.[0-9a-f]{8}\.woff2$/);
    expect(stylesFor('site')).toContain(`url("${url}") format("woff2")`);
  });
});
