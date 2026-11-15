// 31.14.0–31.15.0: an island re-reads a query on a timer through `useQuery`'s `poll`, and a mount
// replaces server markup through `mountOver` — two CLAUDE.md rows. Prose: each lands where the
// text stands as `x new` wrote it, and is skipped silently where the app reworded it.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const ISLANDS =
  '| Islands | every `*.island.tsx` has a sibling `*.island.states.ts`, so `bunx x shot --island` can photograph its failures | `guards/island-without-states.ts` |';

export const DOCS_ISLAND_EDITS: readonly SnippetEdit[] = [
  {
    from: '| Polling | an island re-reads on a timer with `visibleInterval(run, ms)` from `@ultimat3/core/page` — no call while the tab is hidden, none after a lost session — never a bare `setInterval(`; a `// why:` on the line admits a tick that is not a read | `guards/raw-interval.ts` |',
    to: '| Polling | an island re-reads a query on a timer with `useQuery(ref, input, { poll: pollEvery(ms) })` (`@ultimat3/realtime`), anything else with `visibleInterval(run, ms)` from `@ultimat3/core/page` — no call while the tab is hidden, none after a lost session — never a bare `setInterval(`; a `// why:` on the line admits a tick that is not a read | `guards/raw-interval.ts` |',
    optional: true,
  },
  {
    from: ISLANDS,
    to: `${ISLANDS}\n| Island mounts | a \`mount\` replaces its server markup through \`mountOver\`, so a render that throws shows the server's HTML, not a blank box | \`guards/island-mount-clears.ts\` |`,
    optional: true,
  },
];

export const codemod: Codemod = {
  id: 'docs-island-rows',
  since: '31.15.0',
  summary:
    "CLAUDE.md's Polling row names useQuery's poll, and an Island mounts row joins the table",
  run: (app) => editSnippets(app, 'CLAUDE.md', DOCS_ISLAND_EDITS),
};
