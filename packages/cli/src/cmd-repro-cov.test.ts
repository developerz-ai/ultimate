// `x repro --from <file>` in process, on a scratch app — the path that needs no database: the
// subject's facts, `--write` landing the replay, and `--verify` reading the written test's run.
// The runner is scripted (a `bun test` of the replay is the one process this command starts).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { FailureBundle } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import { reproCommand } from './cmd-repro';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-repro-cmd-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');

const BUNDLE: FailureBundle = {
  id: 'bundle-1',
  fingerprint: 'fp-1',
  code: 'X_PLANTED',
  operation: null,
  primitive: 'action',
  name: 'createPost',
  at: 0,
  requestId: 'req-1',
  traceId: null,
  build: 'b-1',
  input: {},
  masked: ['card'],
  actor: null,
  flags: {},
  reads: [],
  truncated: false,
};

const FAILURE: JobFailure = {
  jobId: '00000000-0000-4000-8000-0000000000aa',
  name: 'charge',
  input: {},
  masked: [],
  steps: [],
  code: 'X_DECLINED',
  step: null,
};

const BUNDLE_FILE = join(root, 'bundle.json');
const JOB_FILE = join(root, 'job.json');
await Bun.write(BUNDLE_FILE, JSON.stringify({ ok: true, data: { bundle: BUNDLE } }));
await Bun.write(JOB_FILE, JSON.stringify(FAILURE));

/** One scripted `bun test` result; every call is recorded so its count is asserted. */
const scripted = (result: Pick<ExecResult, 'ok' | 'stdout' | 'stderr'>) => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    calls.push(command);
    return { command, code: result.ok ? 0 : 1, durationMs: 1, ...result };
  };
  return { runner, calls };
};

const ctxOf = (argv: readonly string[], runner: Runner, env = {}): CommandContext => ({
  args: parseArgs(['repro', ...argv], [reproCommand.spec]),
  cwd: root,
  runner,
  env,
  bunVersion: Bun.version,
});

describe('x repro --from', () => {
  test('no id, no --from and no --list is refused before the app loads', async () => {
    const { runner } = scripted({ ok: true, stdout: '', stderr: '' });
    const code = await reproCommand.run(ctxOf([], runner)).then(
      () => expect.unreachable('x repro answered with nothing to reproduce'),
      (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
    );
    expect(code).toBe('X_CLI_BAD_FLAG');
  });

  test('a request bundle answers its code, group, build and masked fields, and writes nothing', async () => {
    const { runner, calls } = scripted({ ok: true, stdout: '', stderr: '' });
    const result = await reproCommand.run(ctxOf(['--from', BUNDLE_FILE], runner));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('action createPost answered X_PLANTED — fingerprint fp-1');
    expect(result.data).toMatchObject({
      kind: 'request',
      id: BUNDLE_FILE,
      code: 'X_PLANTED',
      fingerprint: 'fp-1',
      build: 'b-1',
      masked: ['card'],
      bundle: { id: 'bundle-1' },
    });
    expect(calls).toEqual([]);
    expect(await Bun.file(join(root, 'repro/repro-req1.contract.test.ts')).exists()).toBe(false);
  });

  test('a job with --write lands its replay under repro/ and names it', async () => {
    const { runner, calls } = scripted({ ok: true, stdout: '', stderr: '' });
    const result = await reproCommand.run(ctxOf(['job-7', '--from', JOB_FILE, '--write'], runner));
    const file = 'repro/repro-000000000000.job.test.ts';
    expect(result.summary).toBe(
      'job charge (00000000-0000-4000-8000-0000000000aa) died with X_DECLINED at step (the body)',
    );
    expect(result.lines).toEqual([`  wrote ${file}`]);
    expect(result.data).toMatchObject({ kind: 'job', id: 'job-7', file, build: null });
    expect(await Bun.file(join(root, file)).text()).toContain('x repro job-7:');
    expect(calls).toEqual([]);
  });

  test('--verify that reproduces the captured code is ok and says so', async () => {
    const { runner, calls } = scripted({
      ok: false,
      stdout: '',
      stderr: 'Received: "X_PLANTED: boom"',
    });
    const result = await reproCommand.run(ctxOf(['--from', BUNDLE_FILE, '--verify'], runner));
    expect(calls).toEqual([['bun', 'test', './repro/repro-req1.contract.test.ts']]);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ reproduced: true, got: 'X_PLANTED' });
    expect(result.lines?.at(-1)).toBe(
      '  reproduced: repro/repro-req1.contract.test.ts fails with X_PLANTED',
    );
  });

  test('--verify on a green run is not ok and reports X_REPRO_NOT_REPRODUCED', async () => {
    const { runner } = scripted({ ok: true, stdout: '', stderr: '' });
    const result = await reproCommand.run(
      ctxOf(['--from', BUNDLE_FILE, '--verify'], runner, { BUILD_ID: 'b-2' }),
    );
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ reproduced: false, got: null });
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_REPRO_NOT_REPRODUCED']);
    expect(result.lines?.at(-1)).toBe(
      '  not reproduced: repro/repro-req1.contract.test.ts ended in a pass',
    );
    const written = await Bun.file(join(root, 'repro/repro-req1.contract.test.ts')).text();
    expect(written).toContain('Captured on build b-1, replayed on b-2');
  });
});
