// `probeDatabaseName` is the one way a live or contract suite names the database it creates and
// drops: a fixed name let two runs against one server drop each other's database mid-suite (#705).

import { describe, expect, test } from 'bun:test';
import { PROBE_DATABASE_NAME_MAX, probeDatabaseName } from './probe-database';

/** 2027-01-15T08:00:00Z; its second in base 36 is `tro8w0`. */
const now = 1_800_000_000_000;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

describe('probeDatabaseName', () => {
  test('is the prefix, the pid, the creation second and eight hex characters', () => {
    expect(probeDatabaseName('x_jobs_claim', { pid: 4242, random: 'ABCDEF01-2345', now })).toBe(
      'x_jobs_claim_4242_tro8w0_abcdef01',
    );
  });

  test('two calls in one process name two different databases', () => {
    const names = new Set(Array.from({ length: 50 }, () => probeDatabaseName('x_probe')));
    expect(names.size).toBe(50);
    for (const name of names) expect(name.startsWith(`x_probe_${String(process.pid)}_`)).toBe(true);
  });

  test('two processes never share a name, whatever their randomness', () => {
    const random = '00000000';
    expect(probeDatabaseName('x_p', { pid: 1, random })).not.toBe(
      probeDatabaseName('x_p', { pid: 2, random }),
    );
  });

  test('is a valid unquoted Postgres identifier for any prefix', () => {
    for (const prefix of ['X-Mail Outbox', '9lives', '', 'ünïcode', 'drop table x;--']) {
      const name = probeDatabaseName(prefix, { pid: 1234567, random: 'deadbeef', now });
      expect(name).toMatch(IDENTIFIER);
      expect(name.endsWith('_1234567_tro8w0_deadbeef')).toBe(true);
    }
  });

  test('never exceeds 63 bytes, so Postgres never truncates two names into one', () => {
    const name = probeDatabaseName('x'.repeat(200), { pid: 4_194_304, random: 'cafebabe', now });
    expect(PROBE_DATABASE_NAME_MAX).toBe(63);
    expect(new TextEncoder().encode(name).length).toBe(PROBE_DATABASE_NAME_MAX);
    // Truncation takes the PREFIX, never the suffix that makes the name unique.
    expect(name.endsWith('_4194304_tro8w0_cafebabe')).toBe(true);
  });

  test('a random part with too few hex characters is padded, never shortened', () => {
    expect(probeDatabaseName('x_p', { pid: 7, random: '--a--', now })).toBe(
      'x_p_7_tro8w0_a0000000',
    );
  });
});
