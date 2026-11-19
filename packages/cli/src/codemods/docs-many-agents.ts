// 31.48.0: CLAUDE.md states who runs what when several agents share a machine, the rule the machine
// ledger exists to back. Prose: it lands where the table stands as `x new` wrote it, and is skipped
// silently where the app reworded that row or already says it.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const CLAUDE = 'CLAUDE.md';
const NEXT_ROW = '| One way | generators, not hand-rolled files:';

/** Terse on purpose: a shaped app's CLAUDE.md sits within bytes of `AGENTS_MD_MAX_BYTES`. */
export const MANY_AGENTS_ROW =
  '| Many agents | a worker runs its own files; the coordinator runs the gate once | `bunx x heavy status` |';

export const DOCS_MANY_AGENTS_EDITS: readonly SnippetEdit[] = [
  { from: NEXT_ROW, to: `${MANY_AGENTS_ROW}\n${NEXT_ROW}`, optional: true },
];

export const codemod: Codemod = {
  id: 'docs-many-agents',
  since: '31.48.0',
  summary: "CLAUDE.md's table says a worker runs its own files and the coordinator runs the gate",
  async run(app) {
    if (((await app.read(CLAUDE)) ?? '').includes('x heavy status')) {
      return { changed: [], skipped: [] };
    }
    return editSnippets(app, CLAUDE, DOCS_MANY_AGENTS_EDITS);
  },
};
