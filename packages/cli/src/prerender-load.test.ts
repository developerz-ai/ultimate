// A static build over an app whose module will not import. The load's findings were discarded: the
// page vanished from the export, the directory was emptied first, and `x build` reported success
// over an artifact holding only `404.html` and `favicon.ico` (s2-cli #5).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes } from '@ultimat3/render';
import { clearStylesheets } from '@ultimat3/render/server';
import { prerenderSite } from './prerender';
import { EXPORT_MARKER } from './prerender-out';

// Inside the package, so the fixture's `@ultimat3/*` imports resolve.
const ROOT = join(import.meta.dir, '..', '.prerender-load-fixture');
const OUT = join(ROOT, 'static');

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-load-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  clearRoutes();
  clearStylesheets();
  await rm(ROOT, { recursive: true, force: true });
});

describe('x build --target static over a module that will not import', () => {
  test('the build fails naming the module, and the last export is left as it was', async () => {
    await Bun.write(
      join(ROOT, 'apps/web/site/page.tsx'),
      "throw new TypeError('the page threw at import');\nexport {};\n",
    );
    // The previous build's artifact: marked, so only the load failure can be what refuses it.
    await Bun.write(join(OUT, EXPORT_MARKER), '');
    await Bun.write(join(OUT, 'index.html'), '<p>last good build</p>');

    const thrown = await prerenderSite({ root: ROOT, out: OUT, origin: 'https://example.test' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(thrown).toBeUltimateError('X_BUILD_FAILED');
    const failure = thrown as { cause: string; fix: string };
    expect(failure.cause).toContain('apps/web/site/page.tsx');
    expect(failure.fix).toBe('x verify --only manifest --json');
    expect(await Bun.file(join(OUT, 'index.html')).text()).toBe('<p>last good build</p>');
  });
});
