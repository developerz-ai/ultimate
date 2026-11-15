// `redactSubject` over a declared app: a `.sensitive()` input field, a sealed column, a secret-named
// key in a read row and in a step output are masked; an undeclared entity's rows are dropped; only
// the entities the failing call read are described. Lookups are a table, so no registry is touched.

import { describe, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import type { EntityDescription } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { JobFailure } from '@ultimat3/testing';
import type { ReproLookups } from './repro-redact';
import { redactSubject } from './repro-redact';

const describedAs = (name: string): EntityDescription =>
  ({ name, table: `${name}s`, columns: [] }) as unknown as EntityDescription;

const LOOKUPS: ReproLookups = {
  inputSchema: (kind, name) =>
    (kind === 'action' && name === 'pay') || (kind === 'job' && name === 'charge')
      ? t.object({ pan: t.string.sensitive(), note: t.string })
      : undefined,
  entity: (name) =>
    name === 'card' || name === 'order'
      ? { description: describedAs(name), sealed: name === 'card' ? ['number'] : [] }
      : undefined,
};

const BUNDLE: FailureBundle = {
  id: 'b1',
  fingerprint: 'fp',
  code: 'X_BOOM',
  operation: null,
  primitive: 'action',
  name: 'pay',
  at: 0,
  requestId: 'r1',
  traceId: null,
  build: null,
  input: { pan: '4111-PLANTED', note: 'kept' },
  masked: [],
  actor: null,
  flags: { beta: { webhookSecret: 'flag-PLANTED' } },
  reads: [
    {
      entity: 'card',
      row: { id: 'c1', number: 'sealed-PLANTED', resetToken: 'rt-PLANTED' },
      masked: [],
    },
    { entity: 'audit', row: { id: 'a1', body: 'unrelated-PLANTED' }, masked: [] },
  ],
  truncated: false,
};

const FAILURE: JobFailure = {
  jobId: 'j1',
  name: 'charge',
  input: { pan: '4111-PLANTED', note: 'kept' },
  masked: [],
  steps: [{ name: 'auth', output: { accessToken: 'at-PLANTED', ok: true } }],
  code: 'X_BOOM',
  step: 'capture',
};

describe('redactSubject', () => {
  test('a request keeps nothing planted, and says what it masked and dropped', () => {
    const redacted = redactSubject({ kind: 'request', bundle: BUNDLE }, LOOKUPS);
    expect(JSON.stringify(redacted)).not.toContain('PLANTED');
    expect(redacted.masked).toEqual(['pan', 'card:resetToken']);
    expect(redacted.dropped).toEqual(['audit']);
    expect(redacted.entities.map((entity) => entity.name)).toEqual(['card']);
    if (redacted.subject.kind !== 'request') return expect.unreachable('kind changed');
    expect(redacted.subject.bundle.input).toEqual({ pan: '[redacted]', note: 'kept' });
    expect(redacted.subject.bundle.reads).toEqual([
      { entity: 'card', row: { id: 'c1', resetToken: '[redacted]' }, masked: ['resetToken'] },
    ]);
    expect(redacted.subject.bundle.truncated).toBe(true);
  });

  test('a job masks its input by its schema and its step outputs by key', () => {
    const redacted = redactSubject({ kind: 'job', failure: FAILURE }, LOOKUPS);
    expect(JSON.stringify(redacted)).not.toContain('PLANTED');
    expect(redacted.masked).toEqual(['pan', 'step:auth:accessToken']);
    if (redacted.subject.kind !== 'job') return expect.unreachable('kind changed');
    expect(redacted.subject.failure.masked).toEqual(['pan']);
    expect(redacted.subject.failure.steps).toEqual([
      { name: 'auth', output: { accessToken: '[redacted]', ok: true } },
    ]);
  });
});
