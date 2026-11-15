// 31.22.0: the app's CLAUDE.md states the refusal rule in one line, the Repos row names the two
// repo guards that report, and the paragraph `bunx x verify` already says of itself is gone.
// Prose the app may have reworded: each edit lands where the text stands as `x new` wrote it.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const lines = (...text: readonly string[]): string => text.join('\n');

const COMMANDS =
  'Commands: `bun run setup`, `bun run dev`, `bun run verify`, `bunx x g <primitive>`,';

export const DOCS_GATE_EDITS: readonly SnippetEdit[] = [
  {
    from: lines(
      'Every row below names what refuses it. A rule with nothing in the last column is a rule that does',
      'not exist — five of these had an empty column and were each measured green on `bunx x verify`.',
    ),
    to: lines(
      'Every row below names what refuses it. A rule with nothing in the last column does not exist.',
    ),
    optional: true,
  },
  {
    from: lines(
      '| Repos | a `repo.ts` reads through the typed handle, never a `sql` literal the handle can express | `guards/repo-raw-sql.ts` |',
    ),
    to: lines(
      "| Repos | a `repo.ts` reads through the typed handle, never a `sql` literal it can express; reported, not refused: an `await` per loop turn outside `expectedQueryLoop('<why>', fn)`, a bare `.all()` (it stops at 50 rows: say `.limit(n)`) | `guards/repo-raw-sql.ts`, `guards/repo-await-in-loop.ts`, `guards/repo-unbounded.ts` |",
    ),
    optional: true,
  },
  {
    from: lines(
      '`bun run verify` is `bunx x verify`, the whole gate: its `budgets` step runs',
      '`bunx x build --target static` itself when `.x/build-stats.json` is missing or older than the',
      'source, so nothing has to be built first.',
      '',
      COMMANDS,
    ),
    // Matched with the line after it: an empty `to` would read as already done.
    to: COMMANDS,
    optional: true,
  },
];

export const codemod: Codemod = {
  id: 'docs-gate-prose',
  since: '31.22.0',
  summary: 'CLAUDE.md: the refusal rule in one line, the Repos row with its reporting guards',
  run: (app) => editSnippets(app, 'CLAUDE.md', DOCS_GATE_EDITS),
};
