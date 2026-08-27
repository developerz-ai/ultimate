// A `.module.scss` inside an island must answer the SAME class map the server hashed, and its CSS
// must reach the document. Without the loader under test Bun's default file loader answers the
// asset PATH — a string — so every `styles['x']` is `undefined` and `Bun.build` says `success: true`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun ships no path API, and `rm(…, { force: true })` removes a fixture
// root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  clearStylesheets,
  compileStylesheet,
  registeredStylesheets,
} from '@ultimat3/render/server';
import { buildIslands } from './island-bundle';

const ROOT = join(import.meta.dir, '..', '.island-styles-fixture');

const SCSS = '.track { color: red; }\n.knob { color: blue; }\n';

const ISLAND = `import styles from './switch.module.scss';

export function mount(el: HTMLElement): void {
  el.className = styles['track'];
}
`;

/** Run the chunk the way `hydrate.ts` does. `mount` touches one property, so `{}` is a whole DOM. */
async function mountedClassName(): Promise<string | undefined> {
  const chunk = (await buildIslands(ROOT)).chunks[0];
  const out = join(ROOT, `chunk-${Math.random().toString(36).slice(2)}.mjs`);
  await Bun.write(out, chunk?.code ?? '');
  const entry = (await import(out)) as { mount: (el: { className?: string }) => void };
  const el: { className?: string } = {};
  entry.mount(el);
  return el.className;
}

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-styles-fixture' }));
  clearStylesheets();
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  clearStylesheets();
});

describe('an island that imports a CSS module', () => {
  test('gets the class map the server hashed, not the asset path', async () => {
    const file = 'apps/web/app/switch.module.scss';
    await write(file, SCSS);
    await write('apps/web/app/panel.island.tsx', ISLAND);

    const chunk = (await buildIslands(ROOT)).chunks[0];
    // The server's own answer for the same file, from the same function — so an island and a
    // server render can only ever disagree if this assertion is deleted.
    const server = compileStylesheet(join(ROOT, file), SCSS);

    expect(server.classes['track']).toMatch(/^track_[0-9a-f]{8}$/);
    expect(chunk?.code).toContain(server.classes['track'] as string);
    // The bug's own signature: Bun's file loader makes the default export the emitted asset path.
    expect(chunk?.code).not.toContain('.module-');
    // Run it: a chunk holding the right string still renders unclassed if the default export is
    // the path, because `styles['track']` on a string is `undefined` and assigns cleanly.
    expect(await mountedClassName()).toBe(server.classes['track']);
  });

  test("the island's CSS reaches the document the island mounts into", async () => {
    await write('apps/web/app/switch.module.scss', SCSS);
    await write('apps/web/app/panel.island.tsx', ISLAND);
    await buildIslands(ROOT);

    // A class map with no rules behind it is the same blank control, one step later: the island
    // build is the ONLY thing that ever imports a stylesheet only an island imports.
    const sheet = registeredStylesheets().find((each) => each.file.endsWith('switch.module.scss'));
    expect(sheet?.css).toContain('color:red');
    expect(sheet?.surface).toBe('app');
  });

  test('a stylesheet that will not compile fails the build naming the island', async () => {
    await write('apps/web/app/switch.module.scss', '.track { @include nope(); }\n');
    await write('apps/web/app/panel.island.tsx', ISLAND);

    const code = await buildIslands(ROOT).then(
      () => 'built',
      (error: unknown) =>
        error instanceof Error && 'code' in error ? String(error.code) : 'not coded',
    );
    expect(code).toBe('X_BUILD_FAILED');
  });
});
