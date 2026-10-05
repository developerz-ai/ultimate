#!/usr/bin/env bun
// Enforce that the repository root holds no `bin/` directory: `bun run setup`, `bun run verify` and
// `bun run x -- <args>` are the one path to each job, and a root `bin/setup`, `bin/check`, `bin/dev`
// was the second.
//
// Plan 101 sweep 7 deleted those three wrappers — each a one-line `exec bun run …` that drifted from
// the `package.json` script it restated (CONTRIBUTING.md still asked for Bun >= 1.3 beside them).
// A scaffolded APP's `bin/` is a different thing, written by `x new`, and is not read here.
//
//   bun run root-bin  ·  bun run scripts/root-bin.ts [--json]

// why: Bun.file() answers `exists()` false for a directory, and an empty `bin/` is still one.
import { stat } from 'node:fs/promises';
// why: host-separator paths into the checkout; Bun ships no path API.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'root-bin';

/** What each retired wrapper did, as the command that does it now — the `fix:` hands these over. */
export const REPLACEMENTS: Readonly<Record<string, string>> = {
  setup: 'bun run setup',
  check: 'bun run verify',
  dev: 'bun run x -- <args>',
};

const replacements = Object.entries(REPLACEMENTS)
  .map(([name, command]) => `bin/${name} → ${command}`)
  .join(', ');

/**
 * Anything at `<root>/bin`, file or directory, tracked or not. The filesystem rather than
 * `git ls-files`: a gate step spawns no git, and an untracked `bin/` is one `git add` from tracked.
 */
export async function rootBinFindings(root: string): Promise<readonly Finding[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob('bin/*').scan({ cwd: root, onlyFiles: false, dot: true }),
  );
  const found = await stat(join(root, 'bin')).then(
    () => true,
    () => false,
  );
  if (!found) return [];
  const names = entries.map((entry) => entry.split('\\').join('/')).sort();
  return [
    {
      code: 'X_ROOT_BIN_REINTRODUCED',
      cause: `the repository root has a bin/ (${names.length === 0 ? 'bin' : names.join(', ')}) — a second path beside the package.json scripts, which drifts from them`,
      fix: `git rm -r bin/   # then run the package.json script instead: ${replacements}`,
      at: 'bin/',
    },
  ];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await rootBinFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'no root bin/: bun run setup, bun run verify and bun run x are the one path'
          : 'a root bin/ is back',
      findings,
    },
    args.json,
  );
}
