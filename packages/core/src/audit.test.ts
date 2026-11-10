/**
 * The shared seam's two runtime facts: there is ONE installed sink (installed on ./adapter), and the field list both
 * primitives pin their records to names every field the type declares. The deprecated `action`
 * alias went in 25.0.0: `name` and `primitive` are required.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import type { AuditSink } from './audit';
import { AUDIT_RECORD_FIELDS, getAuditSink, installAuditSink, resetAuditSink } from './audit';
import * as barrel from './index';

afterEach(() => {
  resetAuditSink();
});

describe('unit · the one installed audit sink', () => {
  test('nothing is installed until the boot installs it — there is no default sink', () => {
    expect(getAuditSink()).toBeNull();
  });

  test('the sink installed is the sink read back, by identity', () => {
    const sink: AuditSink = { write: () => undefined };
    installAuditSink(sink);
    expect(getAuditSink()).toBe(sink);
  });

  test('a release removes its own install only, in any order', () => {
    const first: AuditSink = { write: () => undefined };
    const second: AuditSink = { write: () => undefined };
    const releaseFirst = installAuditSink(first);
    const releaseSecond = installAuditSink(second);
    releaseFirst();
    expect(getAuditSink()).toBe(second);
    releaseSecond();
    expect(getAuditSink()).toBeNull();
  });

  test('reset returns to "nothing installed"', () => {
    installAuditSink({ write: () => undefined });
    resetAuditSink();
    expect(getAuditSink()).toBeNull();
  });

  test('the installer is on ./adapter only; the barrel keeps the reader', () => {
    expect(adapter.installAuditSink).toBe(installAuditSink);
    expect(adapter.resetAuditSink).toBe(resetAuditSink);
    expect(barrel.getAuditSink).toBe(getAuditSink);
    const exported = Object.keys(barrel);
    for (const gone of ['setAuditSink', 'installAuditSink', 'resetAuditSink']) {
      expect([gone, exported.includes(gone)]).toEqual([gone, false]);
    }
  });
});

describe('unit · AUDIT_RECORD_FIELDS', () => {
  test('carries `name` and which primitive acted, and no `action` alias', () => {
    expect(AUDIT_RECORD_FIELDS).toContain('name');
    expect(AUDIT_RECORD_FIELDS).not.toContain('action');
    expect(AUDIT_RECORD_FIELDS).toContain('primitive');
  });

  test('is the whole record and nothing else — no result, no rows', () => {
    expect([...AUDIT_RECORD_FIELDS].sort()).toEqual([
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
