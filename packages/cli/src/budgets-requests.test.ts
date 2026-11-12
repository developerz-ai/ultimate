// Requests per route, a measurement in the stats row: the document, every script file the browser
// fetches (an island entry and each chunk it imports, once), and every stylesheet — the number a
// shared vendor chunk or a split stylesheet moves, reported beside the bytes.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { measureDocumentJs, routeStatsRow } from './budgets';
import { stylesheetRequests } from './budgets-requests';
import { processRoot } from './process-root-fixture';

const dir = processRoot(
  join(tmpdir(), `x-budget-requests-${Bun.hash(import.meta.path).toString(16)}`),
);

async function artifact(): Promise<string> {
  await Bun.write(join(dir, 'islands/a-1.js'), 'import"./chunk-1.js";export const mount=()=>{};');
  await Bun.write(join(dir, 'islands/b-1.js'), 'import"./chunk-1.js";export const mount=()=>{};');
  await Bun.write(join(dir, 'islands/chunk-1.js'), 'export const s=1;');
  await Bun.write(join(dir, 'x-sw-register.js'), 'navigator;');
  return dir;
}

const HTML = [
  '<link rel="stylesheet" href="/styles/app.1.css">',
  '<link rel="stylesheet" href="/styles/app.1.css">',
  '<link href="/styles/print.2.css" rel="stylesheet" media="print">',
  '<link rel="stylesheet" href="https://fonts.example/f.css">',
  '<link rel="preload" href="/styles/app.1.css" as="style">',
  '<script src="/x-sw-register.js"></script>',
  '<script>inline()</script>',
  '<div data-x-entry="/islands/a-1.js"></div>',
  '<div data-x-entry="/islands/b-1.js"></div>',
  '<div data-x-entry="/islands/a-1.js"></div>',
].join('');

describe('unit · requests per route', () => {
  test('stylesheets: each distinct same-origin sheet once, a preload is not a second fetch', () => {
    expect(stylesheetRequests(HTML)).toBe(2);
  });

  test('scripts: every distinct file fetched, framework files included, inline bodies not', async () => {
    const measured = await measureDocumentJs(HTML, await artifact());
    // a-1, b-1, the chunk both import, and the service-worker register.
    expect(measured.scriptRequests).toBe(4);
  });

  test('the row carries the document, the scripts and the sheets, and their total', async () => {
    const measured = await measureDocumentJs(HTML, await artifact());
    expect(measured.styleRequests).toBe(2);
    const row = routeStatsRow('/x', measured, undefined);
    expect(row.requests).toEqual({ documents: 1, scripts: 4, styles: 2, total: 7 });
  });
});
