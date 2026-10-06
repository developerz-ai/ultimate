// A served app/ document is weighed as the browser downloads it (#505): the page boot it names is
// charged from the bytes the process serves, and the runtime chunk that boot makes unfetched is
// not. Without the boot in the document, the runtime chunk is charged exactly as before.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { MeasureOptions } from './budgets';
import { measureDocumentJs } from './budgets';
import { processRoot } from './process-root-fixture';

const dirFor = (name: string): string =>
  processRoot(
    join(tmpdir(), `x-budget-served-${Bun.hash(`${import.meta.path}:${name}`).toString(16)}`),
  );

const RUNTIME = `var r="${'r'.repeat(5_000)}";export{r};`;
const ISLAND = 'await import("./realtime-r1.js");export const mount=()=>{};';
const BOOT = `(()=>{var b="${'b'.repeat(2_000)}"})();`;
const BOOT_URL = '/_x/page-boot/boot1.js';

const options: MeasureOptions = {
  served: new Map([[BOOT_URL, BOOT]]),
  boot: { prefix: '/_x/page-boot/', supplies: new Set(['/islands/realtime-r1.js']) },
};

const entry = '<div data-x-entry="/islands/live-1.js"></div>';
const boot = `<script src="${BOOT_URL}" defer></script>`;

async function artifact(name: string): Promise<string> {
  const dir = dirFor(name);
  await Bun.write(join(dir, 'islands/live-1.js'), ISLAND);
  await Bun.write(join(dir, 'islands/realtime-r1.js'), RUNTIME);
  return dir;
}

describe('unit · measureDocumentJs weighs a served document as served', () => {
  test('with the page boot: the boot is charged, the runtime chunk it supplies is not', async () => {
    const measured = await measureDocumentJs(boot + entry, await artifact('with-boot'), options);
    expect(measured.entries).toEqual([
      { url: BOOT_URL, bytes: BOOT.length },
      { url: '/islands/live-1.js', bytes: ISLAND.length },
    ]);
    expect(measured.jsBytes).toBe(BOOT.length + ISLAND.length);
  });

  test('without the page boot: the island loads the runtime chunk, and is charged for it', async () => {
    const measured = await measureDocumentJs(entry, await artifact('no-boot'), options);
    expect(measured.entries.map((one) => one.url)).toEqual([
      '/islands/live-1.js',
      '/islands/realtime-r1.js',
    ]);
    expect(measured.jsBytes).toBe(ISLAND.length + RUNTIME.length);
  });

  test('a static export, measured with no options, is charged for the runtime as before', async () => {
    const measured = await measureDocumentJs(boot + entry, await artifact('static'));
    // No served scripts: the boot is not in the artifact, so it weighs nothing it does not hold.
    expect(measured.jsBytes).toBe(ISLAND.length + RUNTIME.length);
  });
});
