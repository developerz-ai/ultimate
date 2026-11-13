#!/usr/bin/env bun
// PostToolUse(Edit|Write): the narrow check on the one file just edited — `biome check --write`
// (formats in place, reports what it cannot fix), then `bun run boundaries` for a package file.
// The path arrives on stdin as `tool_input.file_path`; the harness sets no `$CLAUDE_FILE_PATHS`.
// Exit 2 shows Claude the finding (the edit already landed). No typecheck: `tsc -b` writes shared
// `.tsbuildinfo`, and per-edit runs from several agents interleave into errors nobody owns.

// why: walking up to the repository root and relativising the path; Bun ships no path API.
import { dirname, join, relative } from 'node:path';

export type Check = 'format' | 'boundaries';

/** Each check's wall-clock bound; settings.json bounds the hook as a whole at 20 s. */
const BOUND_MS = 9_000;

/** The checks an edit to `path` (relative to the repository root) selects, in run order. */
export function checksFor(path: string): readonly Check[] {
  const posix = path.split('\\').join('/');
  return /^packages\/[^/]+\//.test(posix) ? ['format', 'boundaries'] : ['format'];
}

/** The nearest ancestor holding `.git`, or undefined: a file in no repository is not ours. */
async function repoRootOf(file: string): Promise<string | undefined> {
  // why: a directory test; Bun.file().exists() answers false for one.
  const { existsSync } = await import('node:fs');
  let at = dirname(file);
  for (;;) {
    if (existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

function run(argv: readonly string[], cwd: string): { readonly ok: boolean; readonly out: string } {
  const proc = Bun.spawnSync([...argv], { cwd, timeout: BOUND_MS, stdout: 'pipe', stderr: 'pipe' });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, out };
}

const tail = (text: string, lines: number): string => text.split('\n').slice(-lines).join('\n');

async function main(): Promise<void> {
  const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    tool_input?: { file_path?: unknown };
  };
  const file = record.tool_input?.file_path;
  if (typeof file !== 'string' || file === '') return;
  const root = await repoRootOf(file);
  if (root === undefined) return;
  // This checkout's own biome first: the pinned version, and no network on a fresh machine.
  const local = join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'biome');
  const biome = (await Bun.file(local).exists()) ? [local] : ['bunx', 'biome'];
  const said: string[] = [];
  for (const check of checksFor(relative(root, file))) {
    if (check === 'format') {
      const result = run([...biome, 'check', '--write', '--no-errors-on-unmatched', file], root);
      if (!result.ok)
        said.push(
          `${tail(result.out, 30)}\nfix what it names, then: bunx biome check --write ${file}`,
        );
    } else {
      const result = run(['bun', 'run', 'boundaries'], root);
      if (!result.ok) said.push(`${tail(result.out, 30)}\nre-run: bun run boundaries`);
    }
  }
  if (said.length > 0) {
    process.stderr.write(`.claude/hooks/after-edit.ts on ${file}:\n${said.join('\n\n')}\n`);
    process.exit(2);
  }
}

if (import.meta.main) await main();
