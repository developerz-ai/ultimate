// A `<link rel="modulepreload">` is a fetch: the budget charges its file, once per document beside
// the scripts and island entries naming the same URL, so a preload no island needed is charged
// rather than downloaded unseen (`route-islands-preload.ts` emits them; rules v6).

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { measureDocumentJs } from './budgets';
import { processRoot } from './process-root-fixture';

const dirFor = (name: string): string =>
  processRoot(
    join(tmpdir(), `x-budget-preload-${Bun.hash(`${import.meta.path}:${name}`).toString(16)}`),
  );

const SHARED = `var s="${'s'.repeat(3_000)}";export{s};`;
const STRAY = `var w="${'w'.repeat(4_000)}";export{w};`;
const RUNTIME = `var r="${'r'.repeat(5_000)}";export{r};`;
const ENTRY = 'import"./chunk-1.js";export const mount=()=>{};';
const BOOT_URL = '/_x/page-boot/boot1.js';

const preload = (url: string): string => `<link rel="modulepreload" href="${url}">`;
const entry = '<div data-x-entry="/islands/form-1.js"></div>';

async function artifact(name: string): Promise<string> {
  const dir = dirFor(name);
  await Bun.write(join(dir, 'islands/form-1.js'), ENTRY);
  await Bun.write(join(dir, 'islands/chunk-1.js'), SHARED);
  await Bun.write(join(dir, 'islands/chunk-2.js'), STRAY);
  await Bun.write(join(dir, 'islands/page-runtime.r1.js'), RUNTIME);
  return dir;
}

describe('unit · measureDocumentJs charges modulepreload links', () => {
  test('a preload of a chunk the island imports anyway is charged once, not twice', async () => {
    const measured = await measureDocumentJs(
      entry + preload('/islands/chunk-1.js'),
      await artifact('dedupe'),
    );
    expect(measured.jsBytes).toBe(ENTRY.length + SHARED.length);
  });

  test('a preload of a chunk no island loads is charged — a wrong preload is never free', async () => {
    const measured = await measureDocumentJs(
      entry + preload('/islands/chunk-2.js'),
      await artifact('stray'),
    );
    expect(measured.entries.map((one) => one.url)).toContain('/islands/chunk-2.js');
    expect(measured.jsBytes).toBe(ENTRY.length + SHARED.length + STRAY.length);
  });

  test('a preloaded runtime chunk on a booted document is charged: the preload fetches it', async () => {
    const BOOT = 'void 0;';
    const measured = await measureDocumentJs(
      `<script src="${BOOT_URL}" defer></script>${entry}${preload('/islands/page-runtime.r1.js')}`,
      await artifact('booted'),
      {
        served: new Map([[BOOT_URL, BOOT]]),
        boot: { prefix: '/_x/page-boot/', supplies: new Set(['/islands/page-runtime.r1.js']) },
      },
    );
    expect(measured.jsBytes).toBe(BOOT.length + ENTRY.length + SHARED.length + RUNTIME.length);
  });

  test('any other link — a stylesheet, a plain preload — is not JavaScript and is not charged', async () => {
    const measured = await measureDocumentJs(
      '<link rel="stylesheet" href="/islands/chunk-2.js"><link rel="preload" href="/islands/chunk-2.js">',
      await artifact('other'),
    );
    expect(measured.jsBytes).toBe(0);
  });
});
