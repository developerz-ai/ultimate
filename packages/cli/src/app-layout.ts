// The one feature layout, made a build error: a module `X.ts` beside a directory `X/` in the same
// folder is refused. `x g` writes the directory form — `<slice>/actions/<name>.ts`, one primitive
// per file — and an app that also keeps `actions.ts` has two homes for one kind of thing, where
// `./actions` resolves to the file and never the directory: the reader opens the wrong one.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import type { Finding } from './output';

const MODULE = /^(?<stem>.+)\.(?:ts|tsx)$/;

/** Every `X.ts`/`X.tsx` among `files` that has a directory `X/` holding another of them. */
export function siblingModuleFindings(files: readonly SourceFile[]): readonly Finding[] {
  const directories = new Set<string>();
  for (const { path } of files) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }
  return files.flatMap(({ path }): Finding[] => {
    const stem = MODULE.exec(path)?.groups?.['stem'];
    if (stem === undefined || !directories.has(stem)) return [];
    const name = stem.split('/').at(-1) ?? stem;
    return [
      {
        code: 'X_LAYOUT_SIBLING_MODULE',
        cause: `${path} sits beside the directory ${stem}/ — \`./${name}\` resolves to the file, and the directory form is the one layout`,
        fix: `x verify --only boundaries --json   # move each declaration in ${path} to ${stem}/<its-export-in-kebab-case>.ts, then delete ${path}`,
        docs: ERROR_DOCS_URL,
        at: path,
      },
    ];
  });
}
