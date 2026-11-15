// `redactSubject` over a declared app. Always: a `.sensitive()` input field, a sealed column and a
// secret-named key are masked, an undeclared entity's rows dropped, only touched entities described.
// By default also: every value that is not a key — row columns, input leaves, step outputs — is a
// stand-in the replay fills, and the actor's org is a placeholder. `includeRows` keeps real values.

import { describe, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import type { EntityDescription } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { JobFailure } from '@ultimat3/testing';
import type { ReproLookups } from './repro-redact';
import { ORG_STAND_IN, redactSubject } from './repro-redact';

const ORG = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const describedAs = (name: string): EntityDescription =>
  ({
    name,
    table: `${name}s`,
    columns: [
      { property: 'id', primaryKey: true, references: null },
      { property: 'ownerId', primaryKey: false, references: 'users.id' },
      { property: 'orgId', primaryKey: false, references: 'orgs.id' },
      { property: 'holder', primaryKey: false, references: null },
      // A reference whose name says nothing of a key: kept because the entity declares it one.
      { property: 'author', primaryKey: false, references: 'users.id' },
    ],
  }) as unknown as EntityDescription;

const LOOKUPS: ReproLookups = {
  inputSchema: (kind, name) =>
    (kind === 'action' && name === 'pay') || (kind === 'job' && name === 'charge')
      ? t.object({ pan: t.string.sensitive(), note: t.string, cardId: t.string, qty: t.number })
      : undefined,
  entity: (name) =>
    name === 'card' ? { description: describedAs(name), sealed: ['number'] } : undefined,
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
  input: { pan: '4111-PLANTED', note: 'Ada PLANTED', cardId: 'c1', qty: 2 },
  masked: [],
  actor: {
    kind: 'user',
    id: 'u1',
    orgId: ORG,
    roles: ['member'],
    scopes: [],
    permissions: ['card.pay'],
  },
  flags: { beta: { webhookSecret: 'flag-PLANTED' } },
  reads: [
    {
      entity: 'card',
      row: {
        id: 'c1',
        ownerId: 'u1',
        orgId: ORG,
        holder: 'Ada Lovelace PLANTED',
        author: 'u2',
        number: 'sealed-PLANTED',
        resetToken: 'rt-PLANTED',
      },
      masked: [],
    },
    { entity: 'audit', row: { id: 'a1', body: 'unrelated-PLANTED' }, masked: [] },
  ],
  truncated: false,
};

const FAILURE: JobFailure = {
  jobId: 'j1',
  name: 'charge',
  input: { pan: '4111-PLANTED', note: 'Ada PLANTED', cardId: 'c1', qty: 2 },
  masked: [],
  steps: [
    {
      name: 'auth',
      output: { accessToken: 'at-PLANTED', email: 'ada PLANTED', ok: true, n: 7, chargeId: 'ch1' },
    },
  ],
  code: 'X_BOOM',
  step: 'capture',
};

const request = (includeRows = false) =>
  redactSubject({ kind: 'request', bundle: BUNDLE }, LOOKUPS, { includeRows });

describe('redactSubject', () => {
  test('a request keeps no value that is not a key: rows, input and the org are stand-ins', () => {
    const redacted = request();
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('PLANTED');
    expect(text).not.toContain(ORG);
    if (redacted.subject.kind !== 'request') return expect.unreachable('kind changed');
    const { bundle } = redacted.subject;
    expect(bundle.input).toEqual({
      pan: '[redacted]',
      note: '[redacted]',
      cardId: 'c1',
      qty: '[redacted]',
    });
    expect(bundle.masked).toEqual(['note', 'pan', 'qty']);
    expect(bundle.reads).toEqual([
      {
        entity: 'card',
        row: {
          id: 'c1',
          ownerId: 'u1',
          orgId: ORG_STAND_IN,
          holder: '[redacted]',
          author: 'u2',
          resetToken: '[redacted]',
        },
        masked: ['holder', 'resetToken'],
      },
    ]);
    expect(bundle.actor).toEqual({
      kind: 'user',
      id: 'u1',
      orgId: ORG_STAND_IN,
      roles: ['member'],
      scopes: [],
      permissions: ['card.pay'],
    });
    expect(bundle.truncated).toBe(true);
    expect(redacted.dropped).toEqual(['audit']);
    expect(redacted.entities.map((entity) => entity.name)).toEqual(['card']);
  });

  test('includeRows keeps real values, and still never a secret, sealed or undeclared one', () => {
    const redacted = request(true);
    const text = JSON.stringify(redacted);
    for (const planted of [
      '4111-PLANTED',
      'sealed-PLANTED',
      'rt-PLANTED',
      'flag-PLANTED',
      'unrelated-PLANTED',
    ]) {
      expect(text).not.toContain(planted);
    }
    expect(text).toContain('Ada Lovelace PLANTED');
    expect(text).toContain(ORG);
    expect(redacted.masked).toEqual(['pan', 'card:resetToken']);
  });

  test('a job stands in its input leaves and its step outputs, keys and booleans kept', () => {
    const redacted = redactSubject({ kind: 'job', failure: FAILURE }, LOOKUPS, {
      includeRows: false,
    });
    expect(JSON.stringify(redacted)).not.toContain('PLANTED');
    if (redacted.subject.kind !== 'job') return expect.unreachable('kind changed');
    expect(redacted.subject.failure.masked).toEqual(['note', 'pan', 'qty']);
    expect(redacted.subject.failure.steps).toEqual([
      {
        name: 'auth',
        output: { accessToken: '[redacted]', email: '[redacted]', ok: true, n: 0, chargeId: 'ch1' },
      },
    ]);
    expect(redacted.masked).toEqual([
      'note',
      'pan',
      'qty',
      'step:auth:accessToken',
      'step:auth:email',
      'step:auth:n',
    ]);
  });
});
