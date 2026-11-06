// The edits more than one shape makes to the scaffold's own prose: the CLAUDE.md rows that point at
// files a shape leaves out, and the one line each shape adds to CLAUDE.md (AGENTS.md) and README.md
// naming itself.

import type { NewShape } from '../../new-shapes';
import type { ShapeEdit } from './overlay';

/** The "Copy from" cells of CLAUDE.md's test table that name a file this shape does not write. */
export const claudeRows = (instead: {
  readonly page: string;
  readonly island: string;
}): readonly ShapeEdit[] => [
  {
    path: 'CLAUDE.md',
    find: '| `apps/web/app/dashboard/page.test.ts` |',
    replace: `| ${instead.page} |`,
  },
  {
    path: 'CLAUDE.md',
    find: '| `apps/web/shared/shell.test.ts` |',
    replace: '| `packages/ui/src/card.test.ts` |',
  },
  {
    path: 'CLAUDE.md',
    find: '| `apps/web/shared/theme-toggle.island.test.ts` |',
    replace: `| ${instead.island} |`,
  },
];

const CLAUDE_ANCHOR =
  'There is no global `x`: every command here is `bunx x …`, the CLI this app installs.\n';
const README_ANCHOR = '## 🚀 Start\n\n';

/** One line in CLAUDE.md and one in README.md: which shape this app started as, and what it is. */
export const shapeLines = (shape: NewShape, what: string): readonly ShapeEdit[] => [
  {
    path: 'CLAUDE.md',
    find: CLAUDE_ANCHOR,
    replace: `${CLAUDE_ANCHOR}\nScaffolded as \`x new --shape ${shape}\`: ${what}.\n`,
  },
  {
    path: 'README.md',
    find: README_ANCHOR,
    replace: `${README_ANCHOR}Scaffolded as \`--shape ${shape}\`: ${what}. Next: the three commands below, then \`bunx x g --help\`.\n\n`,
  },
];
