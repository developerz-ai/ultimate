// `x repro --from <file>`: a bundle file as `x repro <id> --json` printed it (`data.bundle`,
// `data.failure`) or bare, read into a subject; anything else is `X_REPRO_UNKNOWN` naming the file.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; each run needs a fresh directory.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch files live under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { FailureBundle } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import { subjectFromFile } from './repro-bundle';

const dir = await mkdtemp(join(tmpdir(), 'x-repro-from-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const BUNDLE: FailureBundle = {
  id: 'b1',
  fingerprint: 'fp1',
  code: 'X_PLANTED',
  operation: null,
  primitive: 'action',
  name: 'createPost',
  at: 0,
  requestId: 'req-1',
  traceId: null,
  build: null,
  input: { title: 'a' },
  masked: [],
  actor: null,
  flags: {},
  reads: [],
  truncated: false,
};

const FAILURE: JobFailure = {
  jobId: '00000000-0000-4000-8000-000000000001',
  name: 'charge',
  input: {},
  masked: [],
  steps: [{ name: 'fetch', output: 1 }],
  code: 'X_PLANTED',
  step: 'charge',
};

const fileWith = async (name: string, value: unknown): Promise<string> => {
  const path = join(dir, name);
  await Bun.write(path, JSON.stringify(value));
  return path;
};

const codeOf = (path: string): Promise<string> =>
  subjectFromFile(path).then(
    () => expect.unreachable(`${path} was read as a subject`),
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

describe('subjectFromFile', () => {
  test('`x repro --json` output carrying data.bundle is a request subject', async () => {
    const path = await fileWith('req.json', { ok: true, data: { bundle: BUNDLE } });
    expect(await subjectFromFile(path)).toEqual({ kind: 'request', bundle: BUNDLE });
  });

  test('data.failure is a job subject', async () => {
    const path = await fileWith('job.json', { ok: true, data: { failure: FAILURE } });
    expect(await subjectFromFile(path)).toEqual({ kind: 'job', failure: FAILURE });
  });

  test('a bare bundle, with no envelope, is read too', async () => {
    const path = await fileWith('bare.json', BUNDLE);
    expect(await subjectFromFile(path)).toEqual({ kind: 'request', bundle: BUNDLE });
  });

  test('a bundle of a primitive capture never stores is no subject', async () => {
    const path = await fileWith('job-primitive.json', { ...BUNDLE, primitive: 'job' });
    expect(await codeOf(path)).toBe('X_REPRO_UNKNOWN');
  });

  test('a job failure with no steps array is no subject', async () => {
    const path = await fileWith('stepless.json', { ...FAILURE, steps: null });
    expect(await codeOf(path)).toBe('X_REPRO_UNKNOWN');
  });

  test('a file that does not exist is X_REPRO_UNKNOWN, not a read error', async () => {
    expect(await codeOf(join(dir, 'absent.json'))).toBe('X_REPRO_UNKNOWN');
  });
});
