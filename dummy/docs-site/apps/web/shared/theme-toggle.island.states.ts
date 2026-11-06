// The states the theme toggle can be photographed in. `x shot --island theme-toggle --json`
// takes one picture per state per theme into `.x/shot/island/theme-toggle/`. PURE DATA: no JSX,
// and the one import is `import type` — the command has to know the list before a browser exists.

import { defineIslandStates } from '@ultimat3/testing';
import type { ThemeToggleIslandProps } from './theme-toggle.island';

export const themeToggleStates = defineIslandStates({
  island: 'apps/web/shared/theme-toggle.island.tsx',
  states: [
    {
      id: 'default',
      title: 'the toggle as the dashboard header renders it',
      props: { locale: 'en' } satisfies ThemeToggleIslandProps,
    },
  ],
});
