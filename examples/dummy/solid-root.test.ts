/**
 * The app ROOT installs the `solid-js` its islands render with, at the version `apps/web` pins.
 * `x build` resolves Solid from the app root (`resolveAppSolid` in `@ultimat3/cli`) so every
 * island chunk ships one runtime; in the image, Bun's isolated linker puts a workspace's
 * dependency under that workspace alone, so a root that names none resolves nothing and the
 * dedupe is silently off. This checkout hoists it, which is why nothing else here notices.
 */

import { expect, test } from 'bun:test';

const dependencies = async (path: string): Promise<Readonly<Record<string, string>>> => {
  const manifest = (await Bun.file(new URL(path, import.meta.url)).json()) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  return manifest.dependencies ?? {};
};

test('the root declares the solid-js apps/web renders with, at the same version', async () => {
  const web = (await dependencies('./apps/web/package.json'))['solid-js'];
  expect(web).toBeString();
  expect((await dependencies('./package.json'))['solid-js']).toBe(web);
});
