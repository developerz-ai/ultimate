// 31.4.1: `defineError` comes from the `@ultimat3/core/page` leaf, which every bundle can load; the
// shipped `error-declared` guard refuses it from the `@ultimat3/core` barrel. A mechanical import
// rewrite over every app source file (the rest of an import stays put), and the prose that names it.

import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const IMPORT = /^import \{([^}]*)\} from '@ultimat3\/core';$/gm;
const LEAF = "import { defineError } from '@ultimat3/core/page';";

/** The rows that name where `defineError` comes from, in CLAUDE.md, the server agent and /feature. */
export const DEFINE_ERROR_PROSE: Readonly<Record<string, readonly SnippetEdit[]>> = {
  'CLAUDE.md': [
    {
      from: '| Errors | never `throw new Error` — declare each code once, `defineError({ code, title, status, cause, fix })` from `@ultimat3/core`, and throw its class; never a handwritten `UltimateError` subclass | `guards/bare-error.ts`, `guards/error-declared.ts` |',
      to: '| Errors | never `throw new Error` — declare each code once, `defineError({ code, title, status, cause, fix })` from `@ultimat3/core/page`, and throw its class; never a handwritten `UltimateError` subclass | `guards/bare-error.ts`, `guards/error-declared.ts` |',
      optional: true,
    },
  ],
  '.claude/agents/server.md': [
    {
      from: '| Errors are instructions | never `throw new Error` — declare each code once with `defineError({ code, title, status, cause, fix })` from `@ultimat3/core`: a stable `X_SCREAMING_SNAKE` code, a cause and a `fix:` a caller can actually run. `guards/error-declared.ts` refuses a handwritten `UltimateError` subclass |',
      to: '| Errors are instructions | never `throw new Error` — declare each code once with `defineError({ code, title, status, cause, fix })` from `@ultimat3/core/page`: a stable `X_SCREAMING_SNAKE` code, a cause and a `fix:` a caller can actually run. `guards/error-declared.ts` refuses a handwritten `UltimateError` subclass |',
      optional: true,
    },
  ],
  '.claude/commands/feature.md': [
    {
      from: 'Never a bare `throw new Error` — declare each code once with `defineError` from `@ultimat3/core`:',
      to: 'Never a bare `throw new Error` — declare each code once with `defineError` from `@ultimat3/core/page`:',
      optional: true,
    },
  ],
};

/** The import with `defineError` taken out to the leaf; unchanged when it does not name it. */
const rewrite = (whole: string, list: string): string => {
  const names = list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (!names.includes('defineError')) return whole;
  const rest = names.filter((name) => name !== 'defineError');
  return rest.length === 0 ? LEAF : `import { ${rest.join(', ')} } from '@ultimat3/core';\n${LEAF}`;
};

async function sources(app: CodemodApp): Promise<CodemodResult> {
  const changed: string[] = [];
  for (const path of await app.glob('{apps,packages}/**/*.{ts,tsx}')) {
    if (path.includes('node_modules/')) continue;
    const source = (await app.read(path)) ?? '';
    if (!source.includes('defineError')) continue;
    const next = source.replace(IMPORT, rewrite);
    if (next === source) continue;
    await app.write(path, next);
    changed.push(path);
  }
  return { changed, skipped: [] };
}

export const codemod: Codemod = {
  id: 'define-error-leaf',
  since: '31.4.1',
  summary: "defineError is imported from '@ultimat3/core/page', never the '@ultimat3/core' barrel",
  async run(app) {
    const results = [await sources(app)];
    for (const [path, edits] of Object.entries(DEFINE_ERROR_PROSE)) {
      results.push(await editSnippets(app, path, edits));
    }
    return mergeResults(results);
  },
};
