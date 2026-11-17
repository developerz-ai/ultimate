// 31.40.0: the `undeclared-env` guard ships, so CLAUDE.md's table names it on an Env row,
// under the Runtime row. Prose: it lands where that row stands as `x new` wrote it, and is skipped
// silently where the app reworded it or already wrote one.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const CLAUDE = 'CLAUDE.md';

const RUNTIME =
  "| Runtime | every Bun pin — `packageManager`, `.bun-version`, CI's `bun-version:`, the image's `FROM oven/bun:` — names the version `engines.bun` declares, and an image builds on a digest | `runtime-pin` |";

/** Terse on purpose: a shaped app's CLAUDE.md sits within bytes of `AGENTS_MD_MAX_BYTES`. */
export const ENVIRONMENT_ROW = '| Env | declared in `envSchema` | `undeclared-env` |';

export const DOCS_ENV_GUARD_EDITS: readonly SnippetEdit[] = [
  { from: RUNTIME, to: `${RUNTIME}\n${ENVIRONMENT_ROW}`, optional: true },
];

export const codemod: Codemod = {
  id: 'docs-env-guard',
  since: '31.40.0',
  summary: "CLAUDE.md's table names the undeclared-env guard on an Env row",
  async run(app) {
    if (((await app.read(CLAUDE)) ?? '').includes('`undeclared-env`')) {
      return { changed: [], skipped: [] };
    }
    return editSnippets(app, CLAUDE, DOCS_ENV_GUARD_EDITS);
  },
};
