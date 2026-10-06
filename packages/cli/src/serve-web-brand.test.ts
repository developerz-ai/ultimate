// The container half of the brand seam, booted for real: `ROLE=web` over an app whose theme module
// declares a brand serves a document carrying the brand `<style>`, under an ENFORCED policy whose
// `style-src` admits every inline style body that document holds. `x dev` is report-only, so this
// is the one process where a missing hash is an unstyled page.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { cspHashSource } from '@ultimat3/http';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import { inlineStyleBodies } from './error-page-csp';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';
import { APP_THEME_MODULE } from './theme-brand';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-brand-fixture'));
const UI = join(import.meta.dir, '../../ui/src/index.ts');
const RENDER = join(import.meta.dir, '../../render/src/index.ts');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('integration · ROLE=web serves the app brand, admitted', () => {
  test('the document carries the brand, and style-src hashes every inline style in it', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-brand-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-brand-fixture' });\n",
    );
    await Bun.write(
      join(ROOT, APP_THEME_MODULE),
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    await Bun.write(
      join(ROOT, 'apps/web/site/page.tsx'),
      `import { defineRoute } from '${RENDER}';\n` +
        'export const config = defineRoute({ render: "ssr", hydrate: "never", offline: "network-only",' +
        ' meta: () => ({ title: "Home", description: "the page the brand is asked of" }) });\n' +
        'export default function Page() { return null; }\n',
    );
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const web = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
    try {
      const response = await fetch(`${web.url}/`, { headers: { accept: 'text/html' } });
      const html = await response.text();
      expect(html.split('</head>')[0]).toContain(brandStyleTag(defineTheme({ preset: 'scifi' })));
      const csp = response.headers.get('content-security-policy') ?? '';
      const styleSrc = csp.split(';').find((part) => part.trim().startsWith('style-src')) ?? '';
      const bodies = inlineStyleBodies(html);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(styleSrc).toContain(cspHashSource(body));
    } finally {
      await web.stop();
    }
  }, 120_000);
});
