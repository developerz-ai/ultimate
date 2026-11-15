// 31.27.0: island coverage is credited to its source through the chunk's source map, so the
// `coveragePathIgnorePatterns` line `x new` wrote to hide the built chunk hides nothing true now.
// Removed with its comment where it stands as written; an edited bunfig.toml keeps its own.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const BUNFIG = 'bunfig.toml';
const PRELOAD = 'preload = ["@ultimat3/testing/preload"]';

export const BUNFIG_EDITS: readonly SnippetEdit[] = [
  {
    from: [
      PRELOAD,
      '# An island is mounted from a BUILT chunk that `mountIsland` writes to a temp .mjs, so',
      '# `bun test --coverage` reports that file: two minified lines, under a name no source has. Bun',
      '# does not remap a pre-built module through its sourcemap (measured on 1.4.0, and the build does',
      "# emit one), so the row can only ever be noise — the island's own .island.tsx is not what it",
      '# describes. Ignoring it removes the phantom; it hides no line any test was covering.',
      'coveragePathIgnorePatterns = ["**/*.mjs"]',
    ].join('\n'),
    // No newline at either end: a bunfig.toml whose last line is the ignore still matches.
    to: PRELOAD,
  },
];

export const codemod: Codemod = {
  id: 'bunfig-island-coverage',
  since: '31.27.0',
  summary: `${BUNFIG}: the island-chunk coverage ignore goes, now that island coverage maps to its source`,
  run: (app) => editSnippets(app, BUNFIG, BUNFIG_EDITS),
};
