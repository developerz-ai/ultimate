// Where `x repro --write` lands a replay and what `--verify` concludes from running it: the file
// name is the subject's id folded to a filename, the source imports the API index only when the
// app has one, and the verdict is read off the RECEIVED value of the red run, never its source.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; each run needs a fresh directory.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { FailureBundle } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import type { ExecOptions, ExecResult, Runner } from './exec';
import type { ReproSubject } from './repro-bundle';
import { reproFile, reproSource, verifyRepro, writeRepro } from './repro-write';

const dir = await mkdtemp(join(tmpdir(), 'x-repro-write-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const FAILURE: JobFailure = {
  jobId: '0A1B2C3D-4E5F-4000-8000-000000000001',
  name: 'charge',
  input: {},
  masked: [],
  steps: [],
  code: 'X_PLANTED',
  step: 'charge',
};
const job: ReproSubject = { kind: 'job', failure: FAILURE };

const BUNDLE: FailureBundle = {
  id: 'bundle-id',
  fingerprint: 'fp',
  code: 'X_PLANTED',
  operation: null,
  primitive: 'action',
  name: 'createPost',
  at: 0,
  requestId: 'Req_42/x',
  traceId: null,
  build: null,
  input: {},
  masked: [],
  actor: null,
  flags: {},
  reads: [],
  truncated: false,
};

/** Answers one scripted result and records what it was asked, so the call is asserted, not faked. */
const scripted = (result: Pick<ExecResult, 'ok' | 'stdout' | 'stderr'>) => {
  const calls: { command: readonly string[]; options: ExecOptions }[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, options });
    return { command, code: result.ok ? 0 : 1, durationMs: 1, ...result };
  };
  return { runner, calls };
};

describe('reproFile', () => {
  test('a job lands as a .job test named by its folded, cut id', () => {
    expect(reproFile(job)).toBe('repro/repro-0a1b2c3d4e5f.job.test.ts');
  });

  test('a request lands as a .contract test named by its request id', () => {
    expect(reproFile({ kind: 'request', bundle: BUNDLE })).toBe(
      'repro/repro-req42x.contract.test.ts',
    );
  });

  test('a request with no request id is named by the bundle id; an id of no letters is unnamed', () => {
    expect(reproFile({ kind: 'request', bundle: { ...BUNDLE, requestId: null } })).toBe(
      'repro/repro-bundleid.contract.test.ts',
    );
    expect(reproFile({ kind: 'request', bundle: { ...BUNDLE, requestId: '--/--' } })).toBe(
      'repro/repro-unnamed.contract.test.ts',
    );
  });
});

describe('reproSource', () => {
  test('imports the API index only when the app has one', async () => {
    const bare = await mkdtemp(join(dir, 'bare-'));
    expect(await reproSource(bare, job, 'id', null)).not.toContain("import '../apps/web/api';");
    const withApi = await mkdtemp(join(dir, 'api-'));
    await Bun.write(join(withApi, 'apps/web/api/index.ts'), 'export {};\n');
    expect(await reproSource(withApi, job, 'id', null)).toContain("import '../apps/web/api';");
  });

  test("a request replays through the app's own db package when it has one", async () => {
    const app = await mkdtemp(join(dir, 'db-'));
    const request: ReproSubject = { kind: 'request', bundle: BUNDLE };
    expect(await reproSource(app, request, 'id', null)).not.toContain('import { driver }');
    await Bun.write(join(app, 'packages/db/package.json'), '{ "name": "@shop/db" }\n');
    const source = await reproSource(app, request, 'id', null);
    expect(source).toContain("import { driver } from '@shop/db';");
    expect(source).toContain('reproduce(BUNDLE, { driver })');
  });
});

describe('writeRepro', () => {
  test('writes the source where the subject lands and spawns nothing without a biome config', async () => {
    const app = await mkdtemp(join(dir, 'write-'));
    const { runner, calls } = scripted({ ok: true, stdout: '', stderr: '' });
    await writeRepro(app, 'repro/repro-a.job.test.ts', '// replay\n', runner);
    expect(await Bun.file(join(app, 'repro/repro-a.job.test.ts')).text()).toBe('// replay\n');
    expect(calls).toEqual([]);
  });
});

describe('verifyRepro', () => {
  const FILE = 'repro/repro-a.job.test.ts';

  test('runs exactly that file with no DATABASE_URL or ULTIMATE_ENV for the child', async () => {
    const { runner, calls } = scripted({ ok: true, stdout: '', stderr: '' });
    await verifyRepro(dir, FILE, 'X_PLANTED', runner, { DATABASE_URL: 'postgres://prod' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual(['bun', 'test', `./${FILE}`]);
    expect(calls[0]?.options.cwd).toBe(dir);
    expect(calls[0]?.options.env).toMatchObject({
      DATABASE_URL: undefined,
      ULTIMATE_ENV: undefined,
    });
    expect(Object.hasOwn(calls[0]?.options.env ?? {}, 'DATABASE_URL')).toBe(true);
  });

  test('a green run did not reproduce, and got nothing', async () => {
    const { runner } = scripted({ ok: true, stdout: 'Received: "X_PLANTED: x"', stderr: '' });
    expect(await verifyRepro(dir, FILE, 'X_PLANTED', runner, {})).toEqual({
      reproduced: false,
      got: null,
    });
  });

  test('red with the captured code as the received value reproduced', async () => {
    const { runner } = scripted({
      ok: false,
      stdout: '',
      stderr: 'expect(received).toBeNull()\n\nReceived: "X_PLANTED: the card was declined"',
    });
    expect(await verifyRepro(dir, FILE, 'X_PLANTED', runner, {})).toEqual({
      reproduced: true,
      got: 'X_PLANTED',
    });
  });

  test("red for another code — even one the test's name mentions — did not", async () => {
    const { runner } = scripted({
      ok: false,
      stdout: '(fail) repro: answers without X_PLANTED',
      stderr: 'Received: "X_OTHER: boom"',
    });
    expect(await verifyRepro(dir, FILE, 'X_PLANTED', runner, {})).toEqual({
      reproduced: false,
      got: 'X_OTHER',
    });
  });

  test('red with no code in the output says so, and no expected code never reproduces', async () => {
    const { runner } = scripted({ ok: false, stdout: 'SyntaxError', stderr: '' });
    expect(await verifyRepro(dir, FILE, null, runner, {})).toEqual({
      reproduced: false,
      got: 'a failure with no code',
    });
  });
});
