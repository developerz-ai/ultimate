// `X_BOUNDARY_LOADER_IMPORT`: an app module importing a registration loader. `defineApi` is an app's
// one registration path (axiom 1); `@ultimat3/{action,query}/loader` are `x`'s module scan's. The one
// boundary rule that also reads an app's TESTS — where an agent reaches for the loader first.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import { commentSafe } from './comment-safe';
import { scanRuntimeImports } from './import-scan';
import type { Finding } from './output';

const LOADER_SUBPATH = /^@ultimat3\/(action|query)\/loader$/;
const LOADER_KEY: Readonly<Record<string, string>> = { action: 'actions', query: 'queries' };

/** One finding per loader import in `files`. Pure: runtime imports only, specifiers as written. */
export function loaderImportFindings(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const specifier of scanRuntimeImports(file)) {
      const loader = LOADER_SUBPATH.exec(specifier)?.[1];
      if (loader === undefined) continue;
      findings.push({
        code: 'X_BOUNDARY_LOADER_IMPORT',
        cause: `an app module imports "${specifier}" — its registration functions are the boot's, and a call here is a second registration path beside defineApi`,
        fix: `export const api = defineApi({ ${LOADER_KEY[loader] ?? 'actions'}: [yourModule] });   # in apps/web/api/index.ts — list the module there, then delete the import from ${commentSafe(file.path)}`,
        docs: ERROR_DOCS_URL,
        at: file.path,
      });
    }
  }
  return findings;
}
