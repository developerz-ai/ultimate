// `x test`'s verdict over what bun reported, not only its exit code: a run whose every test skipped
// itself is not a pass, and a failure's fix narrows to a file that failed instead of rerunning all.

import { describe, expect, test } from 'bun:test';
import type { Runner } from './exec';
import type { TestFile } from './test-select';
import { runShards } from './test-shards';

const answering =
  (stdout: string, code = 0): Runner =>
  async (command) => ({ command, code, ok: code === 0, stdout, stderr: '', durationMs: 3 });

const files = (...paths: readonly string[]): readonly TestFile[] =>
  paths.map((path) => ({ path, bytes: 100 }));

const findingsOf = (result: Awaited<ReturnType<typeof runShards>>) =>
  result.steps?.flatMap((step) => [...step.findings]) ?? [];

describe('unit · x test over a run that ran nothing', () => {
  test('every test skipped: not ok, exit 1, and the cause names the unset service', async () => {
    const result = await runShards({
      root: '/app',
      runner: answering(' 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file.\n'),
      files: files('apps/web/orders.live.test.ts'),
      workers: 1,
      type: 'live',
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary).not.toContain('passed');
    const [finding] = findingsOf(result);
    expect(finding?.code).toBe('X_TEST_FAILED');
    expect(finding?.cause).toContain('TEST_DATABASE_URL');
    expect(finding?.fix).toContain('&& x test live   # ');
  });

  test('a run that executed a test stays a pass, skips beside it or not', async () => {
    const result = await runShards({
      root: '/app',
      runner: answering(' 1 pass\n 2 skip\n 0 fail\n'),
      files: files('apps/web/orders.live.test.ts'),
      workers: 1,
      type: 'live',
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe('unit · X_TEST_FAILED names the file that failed', () => {
  test('the cause lists the failing files and the fix reruns the first one alone', async () => {
    const output = [
      'apps/web/b.test.ts:',
      '(fail) b breaks [1ms]',
      'apps/web/c.test.ts:',
      '(fail) c breaks [1ms]',
      ' 1 pass',
      ' 2 fail',
    ].join('\n');
    const result = await runShards({
      root: '/app',
      runner: answering(output, 1),
      files: files('apps/web/a.test.ts', 'apps/web/b.test.ts', 'apps/web/c.test.ts'),
      workers: 3,
      type: 'unit',
      filter: 'apps/web/',
      env: {},
    });
    const [finding] = findingsOf(result);
    expect(finding?.code).toBe('X_TEST_FAILED');
    expect(finding?.cause).toContain('apps/web/b.test.ts, apps/web/c.test.ts');
    expect(finding?.fix).toBe('x test unit --filter apps/web/b.test.ts --workers 1');
    // The whole-selection rerun is still reported, where a caller reads it: `data.reproduce`.
    expect((result.data as { reproduce: string }).reproduce).toBe(
      'x test unit --filter apps/web/ --workers 3',
    );
  });
});
