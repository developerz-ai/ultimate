// The static build's shared-chunk half, end to end: a page rendering two islands that import one
// ~20 kB module is charged for that module ONCE, and the service worker precaches it with the page.
// The consumer that found it (notificado.co, 2026-09-29) measured 55.5 kB for a page that loads
// ~34 kB, and raised its route budget from 30 kB to 56 kB to hold a number no browser downloads.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, island, registerRoute } from '@ultimat3/render';
import { readBuildStats } from './budgets';
import { prerenderSite } from './prerender';

const ROOT = join(import.meta.dir, '..', '.prerender-shared-chunks-fixture');

const PAYLOAD_BYTES = 20_000;
const UPLOAD = `
const PAYLOAD = '${'u'.repeat(PAYLOAD_BYTES)}';
export function uploadFile(name: string): string { return name + ':' + PAYLOAD; }
`;
const islandUsing = (label: string, up = '../..'): string => `
import { uploadFile } from '${up}/shared/upload';
export function mount(el: HTMLElement): void { el.textContent = uploadFile('${label}'); }
`;

const Kyc = island({ src: './kyc-file.island.tsx' });
const Einvoice = island({ src: './einvoice-upload.island.tsx' });
const BothPage = (): unknown => [Kyc({ children: '…' }), Einvoice({ children: '…' })];
const OnePage = (): unknown => Kyc({ children: '…' });

const route = defineRoute({
  render: 'static',
  hydrate: 'idle',
  offline: 'precache',
  budget: { js: '60kb' },
  meta: () => ({ title: 'Afiliados', description: 'two islands, one upload helper' }),
});

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'shared-chunks-fixture', version: '1.0.0' }),
  );
  await Bun.write(join(ROOT, 'apps/web/shared/upload.ts'), UPLOAD);
  await Bun.write(join(ROOT, 'apps/web/site/afiliados/kyc-file.island.tsx'), islandUsing('kyc'));
  await Bun.write(
    join(ROOT, 'apps/web/site/afiliados/einvoice-upload.island.tsx'),
    islandUsing('einvoice'),
  );
});

afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

const register = async (): Promise<void> => {
  registerRoute({ file: 'apps/web/site/afiliados/page.tsx', config: route, component: BothPage });
  registerRoute({
    file: 'apps/web/site/afiliados/uno/page.tsx',
    config: route,
    component: OnePage,
  });
  // The single-island page resolves `./kyc-file.island.tsx` against its own directory.
  await Bun.write(
    join(ROOT, 'apps/web/site/afiliados/uno/kyc-file.island.tsx'),
    islandUsing('uno', '../../..'),
  );
};

describe('x build --target static · a module two islands import', () => {
  test('without islands.sharedChunks each island carries its own copy — the default is unchanged', async () => {
    await register();
    await prerenderSite({ root: ROOT, out: join(ROOT, 'static'), origin: 'https://example.test' });
    const rows = new Map(((await readBuildStats(ROOT))?.routes ?? []).map((r) => [r.path, r]));
    expect(rows.get('/afiliados')?.jsBytes ?? 0).toBeGreaterThan(PAYLOAD_BYTES * 2);
  });

  test('with it, is charged to the route once, and is in the export beside the entries that import it', async () => {
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "export const config = { name: 'shared-chunks-fixture', islands: { sharedChunks: true } };\n",
    );
    await register();

    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    const rows = new Map(((await readBuildStats(ROOT))?.routes ?? []).map((r) => [r.path, r]));
    const both = rows.get('/afiliados')?.jsBytes ?? 0;
    const one = rows.get('/afiliados/uno')?.jsBytes ?? 0;

    // The payload once, plus two small entries and the runtime — never the payload twice.
    expect(both).toBeGreaterThan(PAYLOAD_BYTES);
    expect(both).toBeLessThan(PAYLOAD_BYTES * 1.5);
    // A second island on the page costs its own entry, not a second copy of what it shares.
    expect(both - one).toBeLessThan(2_000);

    const html = await Bun.file(join(out, 'afiliados/index.html')).text();
    const entries = [...html.matchAll(/data-x-entry="(?<url>[^"]+)"/g)].map(
      (m) => m.groups?.['url'] ?? '',
    );
    expect(entries).toHaveLength(2);
    const imported = new Set<string>();
    for (const url of entries) {
      const code = await Bun.file(join(out, url.slice(1))).text();
      for (const found of code.matchAll(/"\.\/(?<name>chunk-[0-9a-f]{8}\.js)"/g)) {
        imported.add(found.groups?.['name'] ?? '');
      }
    }
    expect(imported.size).toBe(1);
    for (const name of imported) {
      expect(await Bun.file(join(out, 'islands', name)).exists()).toBe(true);
    }
  });
});
