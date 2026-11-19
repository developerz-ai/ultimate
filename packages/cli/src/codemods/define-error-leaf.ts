// 31.4.1: `defineError` comes from the `@ultimat3/core/page` leaf, which every bundle can load; the
// shipped `error-declared` guard refuses it from the `@ultimat3/core` barrel. A mechanical import
// rewrite over every app source file (the rest of an import stays put), and the prose that names it.

import type { Codemod, CodemodApp, CodemodResult, CodemodSkip } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

// A trailing `// note` after the statement is kept where it was.
const IMPORT = /^import \{([^}]*)\} from '@ultimat3\/core';([ \t]*\/\/[^\n]*)?$/gm;
const leaf = (specifier: string): string => `import { ${specifier} } from '@ultimat3/core/page';`;
/** `defineError`, or `defineError as declare`: the one specifier that moves. */
const MOVES = /^defineError(?:\s+as\s+[A-Za-z_$][\w$]*)?$/;
/** What the rewrite left behind: a barrel import still naming it, in a shape this does not edit. */
const LEFT =
  /\bimport\s*(?:type\s*)?\{[^}]*\bdefineError\b[^}]*\}\s*from\s*['"]@ultimat3\/core['"]/;

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

/**
 * The import with `defineError` taken out to the leaf; unchanged when it does not name it, or when
 * the braces hold a comment — a line this would have to drop or misplace, so it is reported.
 */
const rewrite = (whole: string, list: string, trailing: string | undefined): string => {
  if (list.includes('//') || list.includes('/*')) return whole;
  const names = list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const moved = names.find((name) => MOVES.test(name));
  if (moved === undefined) return whole;
  const rest = names.filter((name) => name !== moved);
  const tail = trailing ?? '';
  return rest.length === 0
    ? `${leaf(moved)}${tail}`
    : `import { ${rest.join(', ')} } from '@ultimat3/core';${tail}\n${leaf(moved)}`;
};

async function sources(app: CodemodApp): Promise<CodemodResult> {
  const changed: string[] = [];
  const skipped: CodemodSkip[] = [];
  for (const path of await app.glob('{apps,packages}/**/*.{ts,tsx}')) {
    if (path.includes('node_modules/')) continue;
    const source = (await app.read(path)) ?? '';
    if (!source.includes('defineError')) continue;
    const next = source.replace(IMPORT, rewrite);
    if (next !== source) {
      await app.write(path, next);
      changed.push(path);
    }
    // Never silently kept: the shipped `error-declared` guard reds this file after the hop.
    if (LEFT.test(next)) {
      skipped.push({
        path,
        reason:
          "imports defineError from '@ultimat3/core' in a shape this codemod does not rewrite (a comment inside the braces, a type-only import, or double quotes)",
        diff: `- defineError (in the import from '@ultimat3/core')\n+ ${leaf('defineError')}`,
      });
    }
  }
  return { changed, skipped };
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
