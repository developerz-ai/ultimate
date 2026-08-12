// The regression the deployed app shipped for its whole life: 64kB of component CSS in the
// document and not one `:root` custom property, so every `rgb(var(--color-bg)/1)` the UI kit
// emits was dropped by the browser. The page looked structurally correct and rendered unstyled.

import { stylesFor } from '@ultimat3/render';
import { expect, unitTest } from '@ultimat3/testing';

/**
 * `await import`, not a static one, for the same reason `loadApp` uses a dynamic import: Bun loads
 * a file's whole static graph before it evaluates the module that installs the `.scss` plugin, so
 * a static `import './global'` here would resolve the stylesheet with no loader in place. The
 * module cache makes repeated calls free, so each test states its own precondition.
 */
const loadGlobalLayer = (): Promise<unknown> => import('./global');

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

unitTest('both surfaces carry the token layer, because shared/ is in both graphs', async () => {
  await loadGlobalLayer();
  for (const surface of ['site', 'app'] as const) {
    expect(stylesFor(surface)).toContain('--color-fg:');
  }
});

unitTest(
  'the global layer leads the document, so the reset cannot lose a specificity tie',
  async () => {
    await loadGlobalLayer();
    expect(stylesFor('site').startsWith(':root{')).toBe(true);
  },
);

unitTest(
  'it is emitted exactly once — `--space-8` is defined in one scope and only one',
  async () => {
    await loadGlobalLayer();
    // Not `--color-fg`: the theme defines that one four times on purpose (light `:root`, the dark
    // media query, and `[data-theme]` for each), so only a theme-invariant token counts copies.
    expect(occurrences(stylesFor('site'), '--space-8:')).toBe(1);
    expect(occurrences(stylesFor('app'), '--space-8:')).toBe(1);
  },
);
