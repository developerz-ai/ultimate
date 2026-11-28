// What `@ultimat3/ui/motion` costs an island, measured with `ui-barrel-bytes.test.ts`'s ruler
// (`ui-bytes-fixture.ts`): a barrel-only island carries no motion module, `MotionToggle` carries the
// motion gate alone, the script half reaches no error registry, and each entry stays under its
// ceiling. Split out of `ui-barrel-bytes.test.ts` for the file-length ceiling.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path API.
import { resolve } from 'node:path';
import {
  chunkBytes,
  chunkOf,
  cleanFixtures,
  islandOf,
  specifier,
  UI_SRC,
  under,
} from './ui-bytes-fixture';

afterAll(cleanFixtures);

/** An entry importing `names` from `@ultimat3/ui/motion`, held so nothing shakes. */
const motionSource = (names: readonly string[]): string =>
  [
    `import { ${names.join(', ')} } from '${specifier('motion/index')}';`,
    `export const held = [${names.join(', ')}];`,
    '',
  ].join('\n');

/**
 * Per-entry ceilings for `@ultimat3/ui/motion`, minified as an island ships, `As of 2026-11-28`
 * (Bun 1.4.4): motionTiming 2,711 B · animate 7,272 · inView+stagger 8,866 · layout 7,982 ·
 * frameLoop 6,539 · scrollLinked 2,019 · Presence 32,338 · PresenceList 32,172 (each component
 * pays the same runtime adapter and error registry `Button` does: 29,997). A ceiling is the
 * measurement plus ~10%, so a regression is noticed and a raise states its bytes here.
 *
 * Raised 2026-11-28, measured: animate +3,414 B, inView+stagger +3,856, layout +3,420, frameLoop
 * +3,877 — `finiteOption` / `assertCoded` from `@ultimat3/core/page` screening `delay` and `amount`
 * (`bun run scripts/finite-bounds.ts`), which brings `UltimateError` into a script-only island.
 * A NaN delay or amount is a refusal with a code and a fix, not a silent WAAPI 0 (axiom 4). An
 * island holding any ui component already carries it: Presence moved +319 B.
 */
const MOTION_CEILINGS: readonly (readonly [string, readonly string[], number])[] = [
  ['motionTiming', ['motionTiming'], 3_000],
  ['animate', ['animate'], 8_000],
  ['inView+stagger', ['inView', 'stagger'], 9_750],
  ['layout', ['layout'], 8_750],
  ['frameLoop', ['frameLoop'], 7_250],
  ['scrollLinked', ['scrollLinked'], 2_250],
  ['Presence', ['Presence'], 35_500],
  ['PresenceList', ['PresenceList'], 35_500],
];

describe('@ultimat3/ui/motion: a subpath, measured', () => {
  test('a barrel-only island carries zero motion modules', async () => {
    const chunk = await islandOf('barrel-no-motion', ['Button', 'Dialog', 'ThemeToggle']);
    expect(chunk.modules).toContain(resolve(UI_SRC, 'components/Button.tsx'));
    expect(under(chunk, 'motion/')).toEqual([]);
  }, 30_000);

  test('MotionToggle, on the barrel, carries the motion gate and nothing else of motion/', async () => {
    const chunk = await islandOf('motion-toggle', ['MotionToggle']);
    expect(under(chunk, 'motion/')).toEqual([resolve(UI_SRC, 'motion/motion-gate.ts')]);
  }, 30_000);

  test('the script half (no component) reaches no error registry and no Solid adapter', async () => {
    const chunk = await chunkOf(
      'motion-scripts',
      motionSource(['animate', 'stagger', 'inView', 'layout', 'frameLoop', 'scrollLinked']),
    );
    expect(chunk.modules).not.toContain(resolve(UI_SRC, 'errors.ts'));
    expect(chunk.modules).not.toContain(resolve(UI_SRC, 'theme/solid-adapter.ts'));
  }, 30_000);

  for (const [name, names, ceiling] of MOTION_CEILINGS) {
    test(`${name} stays under ${ceiling} B minified`, async () => {
      const bytes = await chunkBytes(`motion-${name.replace(/\W/g, '-')}`, motionSource(names));
      expect(bytes).toBeLessThanOrEqual(ceiling);
    }, 30_000);
  }
});
