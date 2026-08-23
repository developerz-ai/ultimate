// What one import from `@ultimat3/ui` costs a browser chunk, measured rather than argued.
//
// Two claims, and they answer issue #275 in opposite directions. The barrel SHAKES — a deep path
// into a component module and the barrel produce the same chunk, so component subpath exports
// (`@ultimat3/ui/button`) would buy zero bytes and cost a second import idiom. What does not shake
// is `sideEffects`: `./src/errors.ts` runs `registerErrorCodes()` at import, so any module that
// reaches it drags @ultimat3/core's whole error registry along — which is why the runtime slot is
// its own module and why the ceiling below is small enough to notice it coming back.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path API, and the entry has to be written INSIDE packages/ui — module
// resolution for `@ultimat3/core` walks up from the importing file, and only this package's own
// node_modules has it.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `.tmp/` is gitignored repo-wide, so an interrupted run leaves nothing tracked behind. It has to
 * be inside the package: an entry in the system tmpdir resolves `@ultimat3/core` from nowhere.
 */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp');

/** Production shape, and the one `packages/cli/src/island-bundle.ts` builds an island with. */
async function chunkBytes(name: string, source: string): Promise<number> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: true,
  });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    expect.unreachable(
      `${name} did not bundle: ${built.logs.map((log) => String(log)).join('; ')}`,
    );
  }
  return new TextEncoder().encode(await output.text()).byteLength;
}

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/**
 * Measured 2026-08-23: 72 B once the slot is its own module, 5,713 B while it sat beside `solid()`
 * and reached `errors.ts`. A kilobyte is the ceiling because the failure this pins is not a drift
 * of a few bytes — it is the error registry re-entering the graph, which is ~5.6 kB every time.
 */
const SETTER_CEILING_BYTES = 1024;

describe('the @ultimat3/ui barrel', () => {
  test('costs a browser chunk almost nothing for the runtime registration alone', async () => {
    const bytes = await chunkBytes(
      'setter',
      [
        "import { setSolidRuntime } from '../src/index';",
        'export const mount = (runtime: never): void => setSolidRuntime(runtime);',
        '',
      ].join('\n'),
    );
    expect(bytes).toBeLessThanOrEqual(SETTER_CEILING_BYTES);
  }, 30_000);

  /**
   * The subpath-exports question, decided by measurement instead of by intuition: if the barrel
   * retained what a deep path does not, these two numbers would differ by the difference. They do
   * not, for either a component-shaped export or a pure formatting core — so `@ultimat3/ui/button`
   * would be a second way to import one name for no bytes, which is axiom 1 refusing itself.
   *
   * The slack is not cosmetic and is not "a few bytes for the entry's own name": `Bun.build`
   * 1.4.0 drops `@ultimat3/core`'s `schema-error-codes.ts` — a module core's own `sideEffects`
   * array NAMES — from roughly one build in seventy, which is exactly 377 B of error titles
   * (issue #273, characterised 2026-08-23). Two builds in one process can therefore disagree by
   * that much with no source change at all. `BUN_SHAKE_FLAP_BYTES` is that number, so the
   * assertion still fails for any retention difference a subpath export could actually repair —
   * `useUi` alone is 14 kB and `moneyText` 25 kB.
   */
  const BUN_SHAKE_FLAP_BYTES = 512;

  test.each([
    ['useUi', '../src/theme/context'],
    ['moneyText', '../src/components/money-view'],
  ])(
    'retains no more for %s than the module path does, so a subpath export would buy nothing',
    async (name, module) => {
      const source = (from: string): string =>
        [`import { ${name} } from '${from}';`, `export const held = ${name};`, ''].join('\n');
      const [barrel, deep] = await Promise.all([
        chunkBytes(`${name}-barrel`, source('../src/index')),
        chunkBytes(`${name}-deep`, source(module)),
      ]);
      expect(barrel).toBeLessThanOrEqual(deep + BUN_SHAKE_FLAP_BYTES);
    },
    30_000,
  );
});
