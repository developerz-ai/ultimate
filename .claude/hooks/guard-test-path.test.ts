// Feeds guard-test-path.ts the PreToolUse JSON Claude Code sends and pins its verdict: a bare
// `bun test packages/…` is refused with the `./` spelling, and every anchored form passes.

import { describe, expect, test } from 'bun:test';

const HOOK = `${import.meta.dir}/guard-test-path.ts`;

function run(command: string): { readonly code: number; readonly stderr: string } {
  const proc = Bun.spawnSync(['bun', HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify({ tool_name: 'Bash', tool_input: { command } })),
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

describe('a bare path after bun test is refused', () => {
  test.each([
    ['a package directory', 'bun test packages/mcp'],
    ['a package file', 'bun test packages/core/src/errors.test.ts'],
    ['a bare top-level directory', 'bun test scripts'],
    ['after a name filter', "bun test -t 'merges' packages/cli/src/x.test.ts"],
    ['behind cd and an env prefix', 'cd /tmp && CI=1 bun test packages/core'],
    ['the second of two paths', 'bun test ./packages/core packages/cli'],
  ])('%s', (_name, command) => {
    const { code, stderr } = run(command);
    expect(code).toBe(2);
    expect(stderr).toContain('bun test ./');
  });

  test('the fix names every bare path, anchored', () => {
    expect(run('bun test packages/a packages/b').stderr).toContain(
      'Run: bun test ./packages/a ./packages/b',
    );
  });
});

describe('anchored paths and non-paths pass', () => {
  test.each([
    ['a ./ path', 'bun test ./packages/mcp/'],
    ['an absolute path', 'bun test /repo/packages/core/src/errors.test.ts'],
    ['a ../ path', 'bun test ../core/src/a.test.ts'],
    ['a name filter only, with a path', "bun test ./packages/core -t 'packages/x'"],
    ['a bare word filter', 'bun test errors'],
    ['a flag value that looks like a path', 'bun test --preload scripts/setup.ts ./scripts/'],
    ['bun run test, a script', 'bun run test packages/core'],
    ['a quoted mention', 'echo "bun test packages/core"'],
    ['no bun at all', 'git status'],
  ])('%s', (_name, command) => {
    expect(run(command).code).toBe(0);
  });
});
