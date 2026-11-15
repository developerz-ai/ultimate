// 31.17.0: CI runs the gate cut into parts (`verify plan`, a runner per part, `verify merge`), so
// the app's CLAUDE.md, README.md and /feature say so, and CLAUDE.md gains the Fan-out row. Prose:
// each edit lands where the text stands as `x new` wrote it, and is skipped silently elsewhere.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const lines = (...text: readonly string[]): string => text.join('\n');

const REPOS =
  '| Repos | a `repo.ts` reads through the typed handle, never a `sql` literal the handle can express | `guards/repo-raw-sql.ts` |';

export const DOCS_CI_PARTS_EDITS: Readonly<Record<string, readonly SnippetEdit[]>> = {
  'CLAUDE.md': [
    {
      from: '| One gate | `bun run verify` — `bunx x verify`, which builds what its `budgets` step weighs. Green means shippable; never merge red. CI runs the same two commands as your terminal: `bun run setup && bun run verify` | the gate itself, and `.github/workflows/ci.yml` on every push and pull request; `.github/workflows/image.yml` publishes only a commit it passed |',
      to: '| One gate | `bun run verify` — `bunx x verify`, which builds what its `budgets` step weighs. Green means shippable; never merge red. CI runs the same gate, cut into parts: `bun run verify plan --json` names them, each runner runs `bun run setup && bun run verify --only <steps>`, and `bun run verify merge` is the verdict | the gate itself, and `.github/workflows/ci.yml` on every push and pull request; `.github/workflows/image.yml` publishes only a commit it passed |',
      optional: true,
    },
    {
      from: REPOS,
      to: lines(
        REPOS,
        '| Fan-out | a database call per element of a list runs through `mapBounded(rows, fn, { width })` from `@ultimat3/core` — never `Promise.all(rows.map(async …))`, one statement per row at once; a `// why:` on the line admits a list bounded where it is built | `guards/unbounded-fanout.ts` |',
      ),
      optional: true,
    },
  ],
  'README.md': [
    {
      from: '| `.github/workflows/ci.yml` | `bun run setup` then `bun run verify`, on push and pull request |',
      to: '| `.github/workflows/ci.yml` | on push and pull request: `bun run verify plan` cuts the gate into parts, each runner runs `bun run setup` then its `bun run verify --only …`, and `bun run verify merge` folds them into the one verdict |',
      optional: true,
    },
  ],
  '.claude/commands/feature.md': [
    {
      from: lines(
        '`.x/build-stats.json` is missing or older than the source. CI runs this same script —',
        '`.github/workflows/ci.yml` is `bun run setup` and then `bun run verify`, nothing else.',
      ),
      to: lines(
        '`.x/build-stats.json` is missing or older than the source. CI runs this same script, cut into',
        'parts — `.github/workflows/ci.yml` asks `bun run verify plan` for them, runs `bun run setup` and',
        "each part's `bun run verify --only …`, and `bun run verify merge` is the verdict.",
      ),
      optional: true,
    },
  ],
};

export const codemod: Codemod = {
  id: 'docs-ci-parts',
  since: '31.17.0',
  summary:
    'CLAUDE.md, README.md and /feature describe CI as the gate cut into parts; CLAUDE.md gains Fan-out',
  async run(app) {
    const results = [];
    for (const [path, edits] of Object.entries(DOCS_CI_PARTS_EDITS)) {
      results.push(await editSnippets(app, path, edits));
    }
    return mergeResults(results);
  },
};
