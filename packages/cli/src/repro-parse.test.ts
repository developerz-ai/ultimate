// `parseReproSubject`: a subject read from a file a stranger may have written. Every field the
// replay and the written test read is checked and the subject REBUILT from those fields alone; a
// name, code, step or id carrying a control character (a terminal escape) is no subject at all.

import { describe, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import { parseReproSubject } from './repro-parse';

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
  actor: { kind: 'user', id: 'u1', orgId: null, roles: [], scopes: [], permissions: [] },
  flags: {},
  reads: [{ entity: 'post', row: { id: 'p1' }, masked: [] }],
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

describe('parseReproSubject', () => {
  test('a whole bundle or job failure is a subject, rebuilt without unknown fields', () => {
    expect(parseReproSubject({ ...BUNDLE, extra: 'x' })).toEqual({
      kind: 'request',
      bundle: BUNDLE,
    });
    expect(parseReproSubject({ ...FAILURE, run: '$`rm -rf /`' })).toEqual({
      kind: 'job',
      failure: FAILURE,
    });
  });

  test.each([
    ['a masked list of non-strings', { ...BUNDLE, masked: [1] }],
    ['a read with no row', { ...BUNDLE, reads: [{ entity: 'post', masked: [] }] }],
    ['an actor with no roles', { ...BUNDLE, actor: { kind: 'user', id: 'u1', orgId: null } }],
    ['a clock that is no number', { ...BUNDLE, at: '0' }],
    ['a terminal escape in the name', { ...BUNDLE, name: 'create\u001b[2JPost' }],
    ['a C1 escape in the code', { ...BUNDLE, code: 'X_\u009bPLANTED' }],
    ['a newline in a job step', { ...FAILURE, step: 'a\nb' }],
    ['a job whose steps are not named', { ...FAILURE, steps: [{ output: 1 }] }],
  ])('%s is no subject', (_why, value) => {
    expect(parseReproSubject(value)).toBeUndefined();
  });
});
