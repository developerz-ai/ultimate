#!/usr/bin/env bun
// The package DIRECTORY names, derived from disk — what the per-package CI matrix fans out over.
//
// Separate from `list-workspaces.ts`, which answers package NAMES and versions for the publish
// list. The matrix needs the directory (`core`, not `@ultimat3/core`), and deriving it here is what
// keeps a newly added package from being silently absent from its own gate.
//
//   bun run scripts/list-package-dirs.ts [--json]

import { flagBool, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export function packageDirs(root: string): readonly string[] {
  const dirs = [...new Bun.Glob('packages/*/src').scanSync({ cwd: root, onlyFiles: false })];
  return dirs.map((path) => path.split('/')[1] as string).sort();
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const dirs = packageDirs(repoRoot());
  report(
    {
      ok: dirs.length > 0,
      script: 'list-package-dirs',
      summary: `${dirs.length} package directories`,
      findings: [],
      data: dirs,
    },
    flagBool(args, 'json'),
  );
}
