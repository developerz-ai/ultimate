// Single responsibility: the framework version has ONE reader. `frameworkVersion()` (`version.ts`)
// and the CLI's `loadVersion()` (`version-loader.ts`, the same `resolveVersion`) are the only
// framework sources that read a `@ultimat3/*` manifest's version; a second reader is a second
// version fact to keep in step with the Sentry tag, the boot line and `target_info`.

import { describe, expect, test } from 'bun:test';
// why: Bun has no path-resolution API of its own; `Bun.Glob` scans but does not resolve.
import { resolve } from 'node:path';
import { Glob } from 'bun';

const PACKAGES = resolve(import.meta.dir, '..', '..');

/** Relative to `packages/`. Each answers the version through `resolveVersion`. */
const READERS: ReadonlySet<string> = new Set(['core/src/version.ts', 'cli/src/version-loader.ts']);

/**
 * The spellings of "read this framework package's own manifest": a path built off the module's
 * own directory, a relative JSON import, a `@ultimat3/*` manifest import. A third-party manifest
 * (`require('sass/package.json')`, an installed package's dir) is a different fact and passes.
 */
const OWN_MANIFEST: readonly RegExp[] = [
  /import\.meta\.(?:dir|dirname|path|url)\b[^;]{0,120}['"]package\.json['"]/,
  /(?:from|import\(|require\()\s*['"](?:\.{1,2}\/)+(?:[\w.-]+\/)*package\.json['"]/,
  /(?:from|import\(|require\()\s*['"]@ultimat3\/[\w-]+\/package\.json['"]/,
];

const readsOwnManifest = (text: string): boolean =>
  OWN_MANIFEST.some((pattern) => pattern.test(text));

describe('one framework-version reader', () => {
  test('the detector sees every spelling, and not a third-party manifest', () => {
    expect(readsOwnManifest("resolve(import.meta.dir, '..', 'package.json')")).toBe(true);
    expect(readsOwnManifest("import pkg from '../package.json' with { type: 'json' };")).toBe(true);
    expect(readsOwnManifest("await import('@ultimat3/core/package.json')")).toBe(true);
    expect(readsOwnManifest("require('sass/package.json')")).toBe(false);
    expect(readsOwnManifest("Bun.file(join(dirname(entry), '..', 'package.json'))")).toBe(false);
  });

  test('no packages/*/src file reads a framework manifest except the two readers', async () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for await (const path of new Glob('*/src/**/*.ts').scan({ cwd: PACKAGES })) {
      if (/\.(?:test|[a-z]+\.test)\.ts$/.test(path) || path.includes('/fixtures/')) continue;
      const text = await Bun.file(resolve(PACKAGES, path)).text();
      if (!readsOwnManifest(text)) continue;
      seen.add(path);
      if (!READERS.has(path)) offenders.push(path);
    }
    // The readers must still match, or the detector has gone blind and this test passes vacuously.
    expect([...seen].filter((path) => READERS.has(path)).sort()).toEqual([...READERS].sort());
    expect(offenders).toEqual([]);
  });
});
