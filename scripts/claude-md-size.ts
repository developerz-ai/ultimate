#!/usr/bin/env bun
// Enforce a byte ceiling on `CLAUDE.md`: 16 KB for the root file, 24 KB for a package's, and a
// per-file pin (a ratchet that refuses growth only) for the package files already above it.
//
// Every session loads the root file whole. It reached 64 KB, ~70% of it history, before plan 101
// slice 17 f moved that history to `docs/history/`; nothing stopped it growing back but a sentence.
//
//   bun run scripts/claude-md-size.ts [--json]

// why: host-separator paths to each file; Bun ships no path API.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import { CLAUDE_MD_PINS, CLAUDE_MD_PINS_FILE } from './lib/claude-md-size-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'claude-md-size';
export const ROOT_CEILING = 16 * 1024;
export const PACKAGE_CEILING = 24 * 1024;

const bytes = (n: number): string => `${n.toLocaleString('en-US')} B`;

const unscanned = (at: string, what: string): Finding => ({
  code: 'X_CLAUDE_MD_UNSCANNED',
  cause: `${what}, so no ceiling was checked`,
  fix: 'bun run scripts/claude-md-size.ts --json   # run from the repository root',
  at,
});

/** Pure over the tree and the pin table, so a test can pass both. */
export async function claudeMdFindings(
  root: string,
  pins: Readonly<Record<string, number>> = CLAUDE_MD_PINS,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const top = Bun.file(join(root, 'CLAUDE.md'));
  if (!(await top.exists())) {
    findings.push(unscanned('CLAUDE.md', 'there is no root CLAUDE.md'));
  } else if (top.size > ROOT_CEILING) {
    findings.push({
      code: 'X_CLAUDE_MD_OVERSIZE',
      cause: `CLAUDE.md is ${bytes(top.size)}, over its ${bytes(ROOT_CEILING)} ceiling — every session loads it whole`,
      fix: 'move history and narrative out of CLAUDE.md into docs/history/ and link it; keep rules, the fact table and the command rows',
      at: 'CLAUDE.md',
    });
  }

  const files = await Array.fromAsync(new Bun.Glob('packages/*/CLAUDE.md').scan({ cwd: root }));
  if (files.length === 0)
    findings.push(unscanned('packages/', 'no packages/*/CLAUDE.md was found'));
  for (const found of files.sort()) {
    const path = found.split('\\').join('/');
    const size = Bun.file(join(root, path)).size;
    const pinned = Object.hasOwn(pins, path) ? pins[path] : undefined;
    const ceiling = Math.max(PACKAGE_CEILING, pinned ?? 0);
    if (size <= ceiling) continue;
    findings.push({
      code: 'X_CLAUDE_MD_OVERSIZE',
      cause:
        pinned === undefined
          ? `${path} is ${bytes(size)}, over the ${bytes(PACKAGE_CEILING)} package ceiling`
          : `${path} is ${bytes(size)} and is pinned at ${bytes(pinned)} — a pinned file may shrink, never grow`,
      fix: `move narrative out of ${path} into docs/history/ until it is at most ${bytes(ceiling)}; never raise its row in ${CLAUDE_MD_PINS_FILE}`,
      at: path,
    });
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await claudeMdFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every CLAUDE.md is within its ceiling (root ${bytes(ROOT_CEILING)}, package ${bytes(PACKAGE_CEILING)} or its pin)`
          : `${findings.length} CLAUDE.md file(s) over their ceiling`,
      findings,
    },
    args.json,
  );
}
