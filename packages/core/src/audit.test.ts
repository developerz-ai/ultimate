/**
 * The shared seam's two runtime facts: there is ONE installed sink, and the field list both
 * primitives pin their records to names every field the type declares — `name` and the deprecated
 * `action` alias both, until 25.0.0 drops the alias.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuditSink } from './audit';
import {
  AUDIT_RECORD_FIELDS,
  getAuditSink,
  normalizeAuditRecord,
  resetAuditSink,
  setAuditSink,
} from './audit';
import { createContext } from './context';
import * as barrel from './index';

afterEach(() => {
  resetAuditSink();
});

describe('unit · the one installed audit sink', () => {
  test('nothing is installed until an app installs it — there is no default sink', () => {
    expect(getAuditSink()).toBeNull();
  });

  test('the sink installed is the sink read back, by identity', () => {
    const sink: AuditSink = { write: () => undefined };
    setAuditSink(sink);
    expect(getAuditSink()).toBe(sink);
  });

  test('reset returns to "nothing installed"', () => {
    setAuditSink({ write: () => undefined });
    resetAuditSink();
    expect(getAuditSink()).toBeNull();
  });

  test('the barrel exports the same three functions, not copies', () => {
    expect(barrel.setAuditSink).toBe(setAuditSink);
    expect(barrel.getAuditSink).toBe(getAuditSink);
    expect(barrel.resetAuditSink).toBe(resetAuditSink);
  });
});

describe('unit · AUDIT_RECORD_FIELDS', () => {
  test('carries `name` beside the deprecated `action` alias, and which primitive acted', () => {
    expect(AUDIT_RECORD_FIELDS).toContain('name');
    expect(AUDIT_RECORD_FIELDS).toContain('action');
    expect(AUDIT_RECORD_FIELDS).toContain('primitive');
  });

  test('is the whole record and nothing else — no result, no rows', () => {
    expect([...AUDIT_RECORD_FIELDS].sort()).toEqual([
      'action',
      'at',
      'ctx',
      'failure',
      'idempotencyKey',
      'input',
      'mutator',
      'name',
      'outcome',
      'primitive',
      'replayed',
      'surface',
    ]);
  });

  test('is frozen: a test that pushed to it would widen every other package’s pin', () => {
    expect(Object.isFrozen(AUDIT_RECORD_FIELDS)).toBe(true);
  });
});

describe('unit · normalizeAuditRecord, the one reading at a sink boundary', () => {
  const legacy = {
    at: new Date(0),
    action: 'publishPost',
    mutator: false,
    surface: 'http',
    ctx: createContext({}),
    input: undefined,
    idempotencyKey: null,
    replayed: false,
    outcome: 'allowed',
    failure: null,
  } as const;

  test('a record with `action` alone reads as that name, and as an action', () => {
    expect(normalizeAuditRecord(legacy)).toMatchObject({
      name: 'publishPost',
      action: 'publishPost',
      primitive: 'action',
    });
  });

  test('a record that states both keeps them — a read stays a read', () => {
    const read = { ...legacy, name: 'postList', action: 'postList', primitive: 'query' } as const;
    expect(normalizeAuditRecord(read)).toMatchObject({ name: 'postList', primitive: 'query' });
  });

  test('the caller’s object is never mutated', () => {
    const copy = { ...legacy };
    normalizeAuditRecord(copy);
    expect(Object.hasOwn(copy, 'name')).toBe(false);
  });
});
