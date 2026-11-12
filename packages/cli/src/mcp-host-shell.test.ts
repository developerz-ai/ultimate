// The pure halves of `mcp-host-shell.ts`: which env a shell-parity child gets, the `x test` argv a
// filter becomes, and how the batches `x test` spawned sum into one answer. The real processes are
// `mcp-host.parity.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import { ENVIRONMENT_KEY } from '@ultimat3/core';
import type { ExecOptions, ExecResult, Runner } from './exec';
import { shellEnv, shellRunner, sumRuns, testRunArgs } from './mcp-host-shell';

const seen: ExecOptions[] = [];
const recording: Runner = async (command, options) => {
  seen.push(options);
  return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
};

const input = (declared: boolean) => ({
  root: '/app',
  env: { [ENVIRONMENT_KEY]: 'development', KEEP: '1' },
  runner: recording,
  declared,
});

describe('a child of tests.run / verify.run never inherits the host’s own declaration', () => {
  test('declared by the host: every child gets the key unset, the env without it', async () => {
    seen.length = 0;
    await shellRunner(input(true))(['bun', 'test'], { cwd: '/app', env: { OTHER: '2' } });
    expect(seen[0]?.env).toEqual({ [ENVIRONMENT_KEY]: undefined, OTHER: '2' });
    expect(shellEnv(input(true))).toEqual({ [ENVIRONMENT_KEY]: undefined, KEEP: '1' });
  });

  test('a caller that sets the key itself keeps its own value', async () => {
    seen.length = 0;
    await shellRunner(input(true))(['bun', 'test'], {
      cwd: '/app',
      env: { [ENVIRONMENT_KEY]: 'test' },
    });
    expect(seen[0]?.env).toEqual({ [ENVIRONMENT_KEY]: 'test' });
  });

  test('set by the operator, not the host: left exactly as the shell has it', async () => {
    seen.length = 0;
    await shellRunner(input(false))(['bun', 'test'], { cwd: '/app' });
    expect(seen[0]?.env).toBeUndefined();
    expect(shellEnv(input(false))).toEqual(input(false).env);
  });
});

describe('testRunArgs: a filter is x test’s --filter, never a flag', () => {
  test('a path filter is --filter, and no filter is the whole suite', () => {
    expect(testRunArgs(undefined)).toEqual(['test']);
    expect(testRunArgs('packages/cli')).toEqual(['test', '--filter', 'packages/cli']);
  });

  test('a filter starting with - is refused, never forwarded', () => {
    for (const filter of ['--preload', '-t', ' --coverage']) {
      expect(() => testRunArgs(filter)).toThrow(
        expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
      );
    }
  });
});

const run = (command: readonly string[], stdout: string, code = 0): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 1,
});

describe('sumRuns: every bun test batch, nothing else', () => {
  test('two batches add up; a non-test child is not read as one', () => {
    const total = sumRuns(
      [
        run(['bun', 'test', 'a.test.ts'], ' 3 pass\n 0 fail\n'),
        run(['bun', 'test', 'b.test.ts'], '(fail) b breaks\n 1 pass\n 1 fail\n', 1),
        run(['git', 'status'], 'nothing to commit'),
      ],
      42,
    );
    expect(total).toEqual({
      passed: 4,
      failed: 1,
      skipped: 0,
      durationMs: 42,
      failures: [{ test: 'b breaks', message: 'no error message in the run output' }],
    });
  });
});
