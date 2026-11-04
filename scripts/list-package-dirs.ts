#!/usr/bin/env bun
// The package DIRECTORY names, derived from disk — what the per-package typecheck gate walks.
//
// Separate from `list-workspaces.ts`, which answers package NAMES and versions for the publish
// list. A per-package gate needs the directory (`core`, not `@ultimat3/core`), and deriving it here is what
// keeps a newly added package from being silently absent from its own gate.
//
//   bun run scripts/list-package-dirs.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export function packageDirs(root: string): readonly string[] {
  const dirs = [...new Bun.Glob('packages/*/src').scanSync({ cwd: root, onlyFiles: false })];
  return dirs.map((path) => path.split('/')[1] as string).sort();
}

/**
 * The whole command as a value: the directory list, and the summary that counts it.
 *
 * A function and not a `report()` call, so a test can drive it. The block this moved out of ran
 * only as a process, so every line of it counted as uncovered — a command nothing could exercise
 * was a command nothing had proved.
 */
export function listPackageDirs(root: string): ScriptResult {
  const dirs = packageDirs(root);
  return {
    ok: dirs.length > 0,
    script: 'list-package-dirs',
    summary: `${dirs.length} package directories`,
    findings: [],
    data: dirs,
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(listPackageDirs(repoRoot()), args.json);
}
