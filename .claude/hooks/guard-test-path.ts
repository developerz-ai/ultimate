#!/usr/bin/env bun
// PreToolUse(Bash): refuse `bun test packages/…` without the leading `./`. Bun reads a bare
// argument as a substring FILTER, so `packages/mcp` also runs `examples/dummy/packages/mcp` under
// the wrong config (measured: 86 files and 13 false fails vs 75 and 0). Exit 2 blocks with the fix.

import { simpleCommands } from './guard-git';

/** `bun test` flags whose value is the next word — that word is never a path. */
const WITH_VALUE = new Set([
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--preload',
  '-r',
  '--rerun-each',
  '--seed',
  '--coverage-reporter',
  '--coverage-dir',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
]);

/** The repository's top-level source directories: a bare one is always meant as a path. */
const TOP = new Set(['packages', 'examples', 'dummy', 'scripts', 'docs', '.claude', 'wiki']);

const anchored = (arg: string): boolean =>
  arg.startsWith('./') ||
  arg.startsWith('../') ||
  arg.startsWith('/') ||
  /^[A-Za-z]:[\\/]/.test(arg);

/** Each argument of a `bun test` that reads as a path but is a substring filter. */
export function unanchoredTestPaths(command: string): readonly string[] {
  const found: string[] = [];
  for (const words of simpleCommands(command)) {
    let at = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at++; // FOO=1 bun test …
    if (words[at] !== 'bun' || words[at + 1] !== 'test') continue;
    for (let k = at + 2; k < words.length; k++) {
      const arg = words[k] ?? '';
      if (WITH_VALUE.has(arg)) {
        k++;
        continue;
      }
      if (arg.startsWith('-') || anchored(arg)) continue;
      if (arg.includes('/') || TOP.has(arg)) found.push(arg);
    }
  }
  return found;
}

if (import.meta.main) {
  const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    tool_input?: { command?: unknown };
  };
  const command = typeof record.tool_input?.command === 'string' ? record.tool_input.command : '';
  const bare = unanchoredTestPaths(command);
  if (bare.length > 0) {
    process.stderr.write(
      `BLOCKED by .claude/hooks/guard-test-path.ts: \`bun test ${bare.join(' ')}\` is a substring filter, not a path — it also runs every file whose path merely contains it (examples/dummy/packages/… under the wrong config). Run: bun test ${bare.map((arg) => `./${arg}`).join(' ')}\n`,
    );
    process.exit(2);
  }
}
