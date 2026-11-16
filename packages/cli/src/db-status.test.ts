// `x db status`'s verdict, off one read: shipped against applied, pending and ahead ids, an edited
// migration, and the framework stamp — each a finding only where a serving role would wait or
// `x db migrate` would refuse. The read and the command are `cmd-db-status.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import type { LedgerRow, Migration } from '@ultimat3/db';
import { migrationChecksum } from '@ultimat3/db';
import { dbStatus, dbStatusFindings, dbStatusLines } from './db-status';
import { nextStamp, type StampEntry } from './framework-schema-stamp';

const mine: StampEntry = { version: '31.30.0', schema: 'aaaaaaaaaaaaaaaa' };
const migration = (id: string, up = `create table "t${id}" ("id" text);`): Migration => ({
  id,
  name: id,
  up,
  down: '',
});
const row = (m: Migration, checksum = migrationChecksum(m)): LedgerRow => ({
  id: m.id,
  name: m.name,
  checksum,
  applied_at: '2026-11-15T00:00:00.000Z',
  app_version: '31.29.0',
  duration_ms: 1,
});
const one = migration('0001_a');
const two = migration('0002_b');
const stamped = nextStamp(null, mine);

describe('unit · x db status, the verdict', () => {
  test('current: every shipped id applied, this build stamped — no finding', () => {
    const read = { stamp: stamped, ledger: [row(one), row(two)] };
    const status = dbStatus(read, [one, two], mine);
    expect(status).toMatchObject({
      shipped: ['0001_a', '0002_b'],
      applied: ['0001_a', '0002_b'],
      pending: [],
      ahead: [],
      edited: [],
      framework: { applied: true, version: '31.30.0', schema: mine.schema },
    });
    expect(dbStatusFindings(status, [one, two], read.ledger)).toEqual([]);
  });

  test('behind: the pending ids are the boot refusal, with its fix', () => {
    const status = dbStatus({ stamp: stamped, ledger: [row(one)] }, [one, two], mine);
    expect(status.pending).toEqual(['0002_b']);
    const findings = dbStatusFindings(status, [one, two], []);
    expect(findings.map((finding) => [finding.code, finding.fix])).toEqual([
      ['X_APP_MIGRATIONS_UNAPPLIED', 'x db migrate'],
    ]);
  });

  test('no ledger at all: applied is null and every shipped id is pending', () => {
    const status = dbStatus({ stamp: null, ledger: undefined }, [one], mine);
    expect(status.applied).toBeNull();
    expect(status.pending).toEqual(['0001_a']);
    expect(status.framework.applied).toBe(false);
    expect(dbStatusFindings(status, [one], undefined).map((finding) => finding.code)).toEqual([
      'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      'X_APP_MIGRATIONS_UNAPPLIED',
    ]);
  });

  test('ahead: listed, and served — a rollback is no finding', () => {
    const ledger = [row(one), row(two)];
    const status = dbStatus({ stamp: stamped, ledger }, [one], mine);
    expect(status.ahead).toEqual(['0002_b']);
    expect(dbStatusFindings(status, [one], ledger)).toEqual([]);
    expect(dbStatusLines(status).join('\n')).toContain('0002_b');
  });

  test('ahead BETWEEN shipped ids is no rollback: the conflict x db migrate refuses with', () => {
    const three = migration('0003_c');
    const ledger = [row(one), row(two), row(three)];
    const status = dbStatus({ stamp: stamped, ledger }, [one, three], mine);
    expect(status.ahead).toEqual(['0002_b']);
    expect(dbStatusFindings(status, [one, three], ledger).map((finding) => finding.code)).toEqual([
      'X_MIGRATION_CONFLICT',
    ]);
  });

  test('a rollback over a destructive row is the refusal migrate gives, unless allowed', () => {
    const ledger = [row(one), { ...row(two), destructive: true }];
    const status = dbStatus({ stamp: stamped, ledger }, [one], mine);
    expect(dbStatusFindings(status, [one], ledger, '').map((finding) => finding.code)).toEqual([
      'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    ]);
    expect(dbStatusFindings(status, [one], ledger, '0002_b')).toEqual([]);
  });

  test('an applied migration edited since: the ledger conflict, with its restore fix', () => {
    const ledger = [row(one, 'f'.repeat(64))];
    const status = dbStatus({ stamp: stamped, ledger }, [one], mine);
    expect(status.edited).toEqual(['0001_a']);
    const [finding] = dbStatusFindings(status, [one], ledger);
    expect(finding?.code).toBe('X_MIGRATION_CONFLICT');
    expect(finding?.fix).toStartWith('git log');
    // The applied checksum, so the fix names the revision to restore.
    expect(finding?.fix).toContain('f'.repeat(64));
  });

  test('another build stamped this database: the newest is named, a major skew flagged', () => {
    const other = nextStamp(null, { version: '32.0.0', schema: 'bbbbbbbbbbbbbbbb' });
    const status = dbStatus({ stamp: other, ledger: [] }, [], mine);
    expect(status.framework).toMatchObject({
      applied: false,
      newest: { version: '32.0.0' },
      aheadByMajor: true,
    });
    const both = nextStamp(stamped, { version: '32.0.0', schema: 'bbbbbbbbbbbbbbbb' });
    expect(dbStatus({ stamp: both, ledger: [] }, [], mine).framework).toMatchObject({
      applied: true,
      skew: { version: '32.0.0' },
    });
  });

  test('the human lines carry every fact the json does', () => {
    const lines = dbStatusLines(dbStatus({ stamp: null, ledger: [row(one)] }, [one, two], mine));
    const text = lines.join('\n');
    for (const fact of ['0002_b', '31.30.0', mine.schema]) expect(text).toContain(fact);
  });
});
