// 31.49.0: CLAUDE.md's many-agents row names the commands a worker runs. The row it replaces gave a
// worker none and listed `x heavy status` under "Refused by", which refuses nothing. Prose: it moves
// the row as `x new` or `docs-many-agents` wrote it, and skips one the app reworded.

import type { Codemod } from './codemod';
import { MANY_AGENTS_ROW } from './docs-many-agents';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const CLAUDE = 'CLAUDE.md';

/** Terse on purpose: a shaped app's CLAUDE.md sits within bytes of `AGENTS_MD_MAX_BYTES`. */
export const WORKER_COMMANDS_ROW =
  '| Many agents | a worker: `bun test ./<file>`, `bunx x test --filter <path>`; the coordinator: the gate, once | review |';

export const DOCS_WORKER_COMMANDS_EDITS: readonly SnippetEdit[] = [
  { from: MANY_AGENTS_ROW, to: WORKER_COMMANDS_ROW, optional: true },
];

export const codemod: Codemod = {
  id: 'docs-worker-commands',
  since: '31.49.0',
  summary: "CLAUDE.md's many-agents row names the commands a worker runs",
  run: (app) => editSnippets(app, CLAUDE, DOCS_WORKER_COMMANDS_EDITS),
};
