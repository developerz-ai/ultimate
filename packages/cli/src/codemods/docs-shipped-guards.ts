// 31.28.0: shipped guards run from the installed framework, never a `guards/` copy, so the app's
// CLAUDE.md names each by its guard name (`raw-fetch`, not `guards/raw-fetch.ts`), lists the
// runtime-pin rule, and says how a guard is set; the agents say the same. Prose: each edit lands
// where the text stands as `x new` wrote it, and is skipped silently where the app reworded it.

import { SHIPPED_GUARD_NAMES } from '../templates/scaffold-guards';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const CLAUDE = 'CLAUDE.md';
const lines = (...text: readonly string[]): string => text.join('\n');

const VENDORS =
  "| Vendors | a server `fetch(` carries a `signal` in its own options — better, it is `outbound()` from `@ultimat3/core/outbound`: a deadline, the caller's signal, safe-only retry | `raw-fetch` |";
const RUNTIME =
  "| Runtime | every Bun pin — `packageManager`, `.bun-version`, CI's `bun-version:`, the image's `FROM oven/bun:` — names the version `engines.bun` declares, and an image builds on a digest | `runtime-pin` |";

export const SHIPPED_GUARDS_EDITS: Readonly<Record<string, readonly SnippetEdit[]>> = {
  [CLAUDE]: [
    { from: VENDORS, to: lines(VENDORS, RUNTIME), optional: true },
    {
      from: lines(
        '`guards/` is yours: each file is one rule, discovered by `bunx x verify` and run inside its',
        '`boundaries` step. Delete one to drop the rule, and `bunx x g guard <name>` writes the next.',
      ),
      to: lines(
        "Each lowercase name is a guard the framework ships, run on `bunx x verify`'s `boundaries` step",
        'from the installed version. `guards/shipped.json` sets one\'s severity (`"warning"`, `"off"`);',
        "`bunx x g guard <name>` writes this app's own into `guards/`.",
      ),
      optional: true,
    },
  ],
  '.claude/agents/server.md': [
    {
      from: lines(
        '| Errors are instructions | never `throw new Error` — declare each code once with `defineError({ code, title, status, cause, fix })` from `@ultimat3/core/page`: a stable `X_SCREAMING_SNAKE` code, a cause and a `fix:` a caller can actually run. `guards/error-declared.ts` refuses a handwritten `UltimateError` subclass |',
      ),
      to: lines(
        '| Errors are instructions | never `throw new Error` — declare each code once with `defineError({ code, title, status, cause, fix })` from `@ultimat3/core/page`: a stable `X_SCREAMING_SNAKE` code, a cause and a `fix:` a caller can actually run. the `error-declared` guard refuses a handwritten `UltimateError` subclass |',
      ),
      optional: true,
    },
  ],
  '.claude/agents/web.md': [
    {
      from: lines(
        "Every one of the last five is a build error, not a preference — `guards/` holds them and `bunx x verify`'s",
        '`boundaries` step runs them. Read the guard rather than guessing at the rule.',
      ),
      to: lines(
        'Every one of the last five is a build error, not a preference — a guard the framework ships, run by',
        "`bunx x verify`'s `boundaries` step. Read the guard's finding rather than guessing at the rule.",
      ),
      optional: true,
    },
  ],
};

const SHIPPED = new Set(SHIPPED_GUARD_NAMES);

/** A table row's `guards/<name>.ts` cell, for a guard the framework ships, as its bare name. */
const renamed = (source: string): string =>
  source
    .split('\n')
    .map((line) =>
      line.startsWith('| ')
        ? line.replace(/`guards\/([a-z0-9-]+)\.ts`/g, (cell, name: string) =>
            SHIPPED.has(name) ? `\`${name}\`` : cell,
          )
        : line,
    )
    .join('\n');

async function table(app: CodemodApp): Promise<CodemodResult> {
  const source = await app.read(CLAUDE);
  if (source === undefined) return { changed: [], skipped: [] };
  const next = renamed(source);
  if (next === source) return { changed: [], skipped: [] };
  await app.write(CLAUDE, next);
  return { changed: [CLAUDE], skipped: [] };
}

export const codemod: Codemod = {
  id: 'docs-shipped-guards',
  since: '31.28.0',
  summary:
    'CLAUDE.md and .claude/agents name each shipped guard as the framework runs it, not as a guards/ copy',
  async run(app) {
    const results = [await table(app)];
    // A runtime row only where none is: the insert matches the Vendors row, which stays.
    const runtime = ((await app.read(CLAUDE)) ?? '').includes('| Runtime |');
    for (const [path, edits] of Object.entries(SHIPPED_GUARDS_EDITS)) {
      const todo = path === CLAUDE && runtime ? edits.slice(1) : edits;
      results.push(await editSnippets(app, path, todo));
    }
    return mergeResults(results);
  },
};
