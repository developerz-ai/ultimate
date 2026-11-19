// 31.48.0: CLAUDE.md states who runs what when several agents share a machine, the rule the machine
// ledger exists to back. Prose: it lands above the One way row, in CLAUDE.md or AGENTS.md, within
// the brief's byte budget; otherwise it is reported as skipped with the row to add by hand.

import { editAgentsDocRow } from './agents-doc-row';
import type { Codemod } from './codemod';

const NEXT_ROW = '| One way | generators, not hand-rolled files:';

/** Terse on purpose: a shaped app's CLAUDE.md sits within bytes of `AGENTS_MD_MAX_BYTES`. */
export const MANY_AGENTS_ROW =
  '| Many agents | a worker runs its own files; the coordinator runs the gate once | `bunx x heavy status` |';

export const codemod: Codemod = {
  id: 'docs-many-agents',
  since: '31.48.0',
  summary: "CLAUDE.md's table says a worker runs its own files and the coordinator runs the gate",
  run: (app) =>
    editAgentsDocRow(app, {
      from: NEXT_ROW,
      to: `${MANY_AGENTS_ROW}\n${NEXT_ROW}`,
      row: MANY_AGENTS_ROW,
      said: (text) => text.includes('| Many agents |'),
      missing: `no "${NEXT_ROW}" row to place it above in CLAUDE.md or AGENTS.md`,
    }),
};
