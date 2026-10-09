// The one feature layout, made a build error: a primitive module `actions.ts` (or `live`,
// `queries`, `jobs`, `tasks`) beside the directory of the same name is refused. `x g` writes the
// directory form — `<slice>/actions/<name>.ts`, one primitive per file — and an app that also keeps
// `actions.ts` has two homes for one kind of thing, where `./actions` resolves to the file and never
// the directory. A component module beside its folder (`ui.tsx` + `ui/`) is not a primitive's home,
// and `x g resource` writes exactly that pair.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import type { Finding } from './output';

/** The directories `x g` writes primitives into — the only names the refusal reads. */
export const PRIMITIVE_DIRS: ReadonlySet<string> = new Set([
  'actions',
  'live',
  'queries',
  'jobs',
  'tasks',
]);

const MODULE = /^(?<stem>.+)\.(?:ts|tsx)$/;

/** Every primitive module `X.ts` among `files` beside a directory `X/` holding another of them. */
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
    const name = stem?.split('/').at(-1) ?? '';
    if (stem === undefined || !PRIMITIVE_DIRS.has(name) || !directories.has(stem)) return [];
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
