// 31.49.0: CLAUDE.md's many-agents row names the commands a worker runs. The row it replaces gave a
// worker none and listed `x heavy status` under "Refused by", which refuses nothing. Prose: it moves
// the row as written, within the brief's byte budget; a reworded or absent row is a reported skip.

import { editAgentsDocRow } from './agents-doc-row';
import type { Codemod } from './codemod';
import { MANY_AGENTS_ROW } from './docs-many-agents';

/** Terse on purpose: a shaped app's CLAUDE.md sits within bytes of `AGENTS_MD_MAX_BYTES`. */
export const WORKER_COMMANDS_ROW =
  '| Many agents | a worker: `bun test ./<file>`, `bunx x test --filter <path>`; the coordinator: the gate, once | review |';

export const codemod: Codemod = {
  id: 'docs-worker-commands',
  since: '31.49.0',
  summary: "CLAUDE.md's many-agents row names the commands a worker runs",
  run: (app) =>
    editAgentsDocRow(app, {
      from: MANY_AGENTS_ROW,
      to: WORKER_COMMANDS_ROW,
      row: WORKER_COMMANDS_ROW,
      said: (text) => text.includes(WORKER_COMMANDS_ROW),
      missing:
        'the many-agents row is not the one x new or docs-many-agents wrote (reworded, or never added), so it is left as written',
    }),
};
