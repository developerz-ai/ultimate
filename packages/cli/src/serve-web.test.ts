// `webSurface`, the half of a container boot only `ROLE=web` loads, booted for real over the
// smallest app: the surfaces it promises to mount beside the pages, and the inline scripts it hands
// the ENFORCED policy. `x dev` is report-only, so a body this file forgot to hand over is a page
// that works on a laptop and has its theme boot blocked in the image.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture app root is joined to this directory.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-web-fixture'));
const RENDER = join(import.meta.dir, '../../render/src/index.ts');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** Inline `<script>` bodies — a `src` script is admitted by `'self'`, never by a hash. */
const inlineScriptBodies = (html: string): readonly string[] => {
  const bodies: string[] = [];
  const pattern = /<script(?![^>]*\ssrc=)(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
};

const directive = (csp: string, name: string): string =>
  csp.split(';').find((part) => part.trim().startsWith(`${name} `)) ?? '';

describe('integration · ROLE=web mounts the web surface', () => {
  test('pages, seo files and an enforced policy admitting every inline script', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-web-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-web-fixture' });\n",
    );
    await Bun.write(
      join(ROOT, 'apps/web/site/page.tsx'),
      `import { defineRoute } from '${RENDER}';\n` +
        'export const config = defineRoute({ render: "ssr", hydrate: "never", offline: "network-only",' +
        ' meta: () => ({ title: "Home", description: "the page the surface serves" }) });\n' +
        'export default function Page() { return null; }\n',
    );
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const web = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
    try {
      const page = await fetch(`${web.url}/`, { headers: { accept: 'text/html' } });
      expect(page.status).toBe(200);
      const html = await page.text();
      const csp = page.headers.get('content-security-policy') ?? '';
      // Enforced, not report-only: the container is where a missing hash breaks a page.
      expect(page.headers.get('content-security-policy-report-only')).toBeNull();
      const scriptSrc = directive(csp, 'script-src');
      const bodies = inlineScriptBodies(html);
      // The theme boot is always inlined: an empty list would make the loop below prove nothing.
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(scriptSrc).toContain(cspHashSource(body));

      // The two files the static export writes, served by the container from the same settings.
      const robots = await fetch(`${web.url}/robots.txt`);
      expect([robots.status, robots.headers.get('content-type')?.split(';')[0]]).toEqual([
        200,
        'text/plain',
      ]);
      const sitemap = await fetch(`${web.url}/sitemap.xml`);
      expect(sitemap.status).toBe(200);
      expect(await sitemap.text()).toContain('<urlset');
    } finally {
      await web.stop();
      // stop() drains the PROCESS lifecycle (a module global): left draining, every later file in
      // this process answered 503 X_DRAINING.
      resetLifecycle();
    }
  }, 120_000);
});
