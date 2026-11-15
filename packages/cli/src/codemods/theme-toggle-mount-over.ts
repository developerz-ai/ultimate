// 31.15.0: an island's mount replaces its server markup through `mountOver`, which puts it back if
// the render throws — the shipped `island-mount-clears` guard refuses `el.textContent = ''`. The
// scaffold's own theme toggle, where it stands as `x new` wrote it; the example slice is the app's.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const TOGGLE = 'apps/web/shared/theme-toggle.island.tsx';

const lines = (...text: readonly string[]): string => text.join('\n');

const UI = "import { setSolidRuntime, ThemeToggle, UiProvider } from '@ultimat3/ui';";

export const THEME_TOGGLE_EDITS: readonly SnippetEdit[] = [
  { from: UI, to: lines("import { mountOver } from '@ultimat3/render/client';", UI) },
  {
    from: lines(
      ' * namespace object keeps every export of solid-js alive in the chunk. The shell is cleared before',
      " * `render`, which APPENDS — the server's copy would otherwise stay on screen beside the live one.",
    ),
    to: lines(
      ' * namespace object keeps every export of solid-js alive in the chunk. `mountOver` clears the shell',
      ' * before `render`, which APPENDS, and puts it back if the render throws: a broken toggle shows the',
      " * server's copy, not a blank box, and the throw still reaches the runtime's `data-x-failed`.",
    ),
    optional: true,
  },
  {
    from: lines(
      "  el.textContent = '';",
      "  // Solid's disposer, returned: the client router calls it when it navigates away, and a mount",
      '  // that returns nothing is X_ISLAND_DISPOSER_MISSING.',
      '  return render(',
      '    () => (',
      '      <UiProvider locale={props.locale}>',
      '        <ThemeToggle mode="toggle" />',
      '      </UiProvider>',
      '    ),',
      '    el,',
      '  );',
    ),
    to: lines(
      "  // Solid's disposer, returned: the client router calls it when it navigates away, and a mount",
      '  // that returns nothing is X_ISLAND_DISPOSER_MISSING.',
      '  return mountOver(el, (root) =>',
      '    render(',
      '      () => (',
      '        <UiProvider locale={props.locale}>',
      '          <ThemeToggle mode="toggle" />',
      '        </UiProvider>',
      '      ),',
      '      root,',
      '    ),',
      '  );',
    ),
  },
];

export const codemod: Codemod = {
  id: 'theme-toggle-mount-over',
  since: '31.15.0',
  summary: `${TOGGLE} mounts through mountOver: a toggle whose render throws keeps the server's copy`,
  async run(app) {
    // The import alone would be added to a toggle whose mount the app rewrote: both, or neither.
    const held = (await app.read(TOGGLE)) ?? '';
    if (!held.includes("  el.textContent = '';")) return { changed: [], skipped: [] };
    return editSnippets(app, TOGGLE, THEME_TOGGLE_EDITS);
  },
};
