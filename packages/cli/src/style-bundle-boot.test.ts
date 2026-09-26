// The surface stylesheet URL across two real BOOTS of one app: `loadApp` + the island store, the
// path a container takes, each in its own process. 22.3.2–22.3.4 minted a different URL per boot of
// one image (notificado.co): `.scss` registers in Bun's `onLoad`, whose order is the loader's
// parallel fetch, and the joined bytes followed it. Same sheets, same URL, every boot.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';

const APP = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');

const BOOT = `
  import { loadApp } from ${JSON.stringify(join(import.meta.dir, 'app-load.ts'))};
  import { loadOrBuildIslands } from ${JSON.stringify(join(import.meta.dir, 'island-store.ts'))};
  import { styleBundle } from ${JSON.stringify(join(import.meta.dir, 'style-bundle.ts'))};
  await loadApp(process.cwd());
  await loadOrBuildIslands(process.cwd());
  const bundle = styleBundle();
  console.log(JSON.stringify([bundle.hrefFor('site'), bundle.hrefFor('app')]));
  process.exit(0);`;

const boot = async (): Promise<string> => {
  const child = Bun.spawn(['bun', '-e', BOOT], { cwd: APP, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) expect.unreachable(err);
  return out.trim().split('\n').at(-1) ?? '';
};

describe('unit · one app, two boots, one stylesheet URL', () => {
  test('three concurrent boots of the reference app mint the same URLs', async () => {
    const [first, ...rest] = await Promise.all([boot(), boot(), boot()]);
    expect(first).toMatch(/\/styles\/[0-9a-f]{8}\.css/);
    for (const other of rest) expect(other).toBe(first);
  }, 120_000);
});
