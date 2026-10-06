// The island fixture hands the process its REAL globals back however its mounts are disposed. Each
// mount used to save what it found and put that back, which is right only newest-first: disposing
// A then B left B putting back A's fake `document`/`Element` for every later file in the worker.
// And a mount that never settled (a test timed out inside `mount`) was nobody's to clean up.

import { describe, expect, test } from 'bun:test';
// why: Bun has no synchronous existence check for a DIRECTORY (`Bun.file().exists()` reads files only, and is async)
import { existsSync } from 'node:fs';
import { disposeLiveIslands } from './fixture-island';
import { mount } from './fixture-island-fixtures.test';
import { islandScratchDirs } from './island-scratch';
import { testName } from './test-types';

const PLAIN = 'export function mount(el) { el.textContent = "on"; }\n';
const host = globalThis as unknown as Record<string, unknown>;
const KEYS = ['document', 'Element', 'window', 'probeOrder'] as const;
const descriptors = () =>
  KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

describe(testName('unit', 'the real globals come back in any dispose order'), () => {
  test('mount A, mount B, dispose A, backstop-dispose B: the real globals are back', async () => {
    const real = descriptors();
    const a = await mount(PLAIN, {}, { globals: { probeOrder: 'A' } });
    const documentOfA = host['document'];
    await mount(PLAIN, {}, { globals: { probeOrder: 'B' } });
    const documentOfB = host['document'];
    expect(documentOfB).not.toBe(documentOfA);

    a[Symbol.dispose]();
    // B is still mounted, so B's fakes are what the process holds — never A's, never the real.
    expect(host['document']).toBe(documentOfB);
    expect(host['probeOrder']).toBe('B');

    expect(disposeLiveIslands()).toBe(1);
    expect(descriptors()).toEqual(real);
  });

  test('newest-first still hands the older mount its own globals back', async () => {
    const real = descriptors();
    const a = await mount(PLAIN, {}, { globals: { probeOrder: 'A' } });
    const documentOfA = host['document'];
    const b = await mount(PLAIN, {}, { globals: { probeOrder: 'B' } });
    b[Symbol.dispose]();
    expect(host['document']).toBe(documentOfA);
    expect(host['probeOrder']).toBe('A');
    a[Symbol.dispose]();
    expect(descriptors()).toEqual(real);
  });

  test('a mount that never settles is disposed by the boundary: directory gone, globals back', async () => {
    const real = descriptors();
    const before = new Set(islandScratchDirs());
    void mount('export function mount() { return new Promise(() => {}); }\n', {}).catch(
      () => undefined,
    );
    // Long enough for the chunk to be written and imported and `mount` to be awaiting.
    for (let i = 0; i < 50 && islandScratchDirs().length === before.size; i += 1) {
      await Bun.sleep(1);
    }
    await Bun.sleep(20);
    const [dir] = islandScratchDirs().filter((each) => !before.has(each));
    expect(existsSync(dir ?? '')).toBe(true);

    expect(disposeLiveIslands()).toBe(1);
    expect(existsSync(dir ?? '')).toBe(false);
    expect(descriptors()).toEqual(real);
  });
});
