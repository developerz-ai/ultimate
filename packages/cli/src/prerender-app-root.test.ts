// The static build under a root whose last segment is `app` — the scaffold container's
// `WORKDIR /app`. A real app on disk, loaded the way `x build` loads it, because the defect lived in
// how an IMPORTED stylesheet was classified: registering a sheet by hand would not reach it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes } from '@ultimat3/render';
import { clearStylesheets, setStylesheetRoot } from '@ultimat3/render/server';
import { prerenderSite } from './prerender';

// Inside the package, so the fixture's `@ultimat3/*` imports resolve; `app` is the point.
const FIXTURE = join(import.meta.dir, '..', '.prerender-app-root-fixture');
const APP_ROOT = join(FIXTURE, 'app');

beforeEach(async () => {
  clearRoutes();
  await rm(FIXTURE, { recursive: true, force: true });
});

afterEach(async () => {
  clearRoutes();
  // Both registries are process-global, and this file writes into them.
  clearStylesheets();
  setStylesheetRoot(undefined);
  await rm(FIXTURE, { recursive: true, force: true });
});

// Reproduced in production: the scaffold's Dockerfile builds and serves from `WORKDIR /app`, and the
// stylesheet loader read the surface off the ABSOLUTE path — whose first `app/` segment is the root
// itself. Every sheet classified as `app`, the site bundle was empty, and every prerendered page
// shipped with no `<link>`. A real app on disk, loaded the way `x build` loads it, under a root
// whose last segment is `app`.
describe('an app whose root is a directory named app/', () => {
  test('the site page links its own stylesheet, carrying the global layer and not app/ CSS', async () => {
    await Bun.write(
      join(APP_ROOT, 'package.json'),
      JSON.stringify({ name: 'app-root-fixture', version: '1.0.0' }),
    );
    await Bun.write(join(APP_ROOT, 'apps/web/shared/global.scss'), ':root{--space-9:9rem}\n');
    await Bun.write(join(APP_ROOT, 'apps/web/site/page.module.scss'), '.hero{margin:3px}\n');
    await Bun.write(join(APP_ROOT, 'apps/web/app/feed/panel.module.scss'), '.panel{margin:7px}\n');
    await Bun.write(
      join(APP_ROOT, 'apps/web/site/page.tsx'),
      [
        "import { defineRoute } from '@ultimat3/render';",
        "import '../shared/global.scss';",
        "import styles from './page.module.scss';",
        "export const config = defineRoute({ render: 'static', hydrate: 'never', offline: 'precache',",
        "  meta: () => ({ title: 'Home', description: 'the landing page' }) });",
        'export default function Home() { return <main class={styles.hero} />; }',
        '',
      ].join('\n'),
    );
    // An app/ module with CSS of its own, so an empty site bundle is not the only way to fail.
    await Bun.write(
      join(APP_ROOT, 'apps/web/app/feed/panel.ts'),
      "import styles from './panel.module.scss';\nexport const panel = styles.panel;\n",
    );
    const out = join(APP_ROOT, 'static');

    const report = await prerenderSite({ root: APP_ROOT, out, origin: 'https://example.test' });

    const html = await Bun.file(join(out, 'index.html')).text();
    const href = /<link rel="stylesheet" href="(?<url>[^"]+)">/.exec(html)?.groups?.['url'] ?? '';
    expect(href).toMatch(/^\/styles\/[0-9a-f]{8}\.css$/);
    expect(report.styles).toContain(href);
    const css = await Bun.file(join(out, href.slice(1))).text();
    expect(css).toContain('margin:3px');
    expect(css).toContain('--space-9:9rem');
    expect(css).not.toContain('margin:7px');
  });
});
