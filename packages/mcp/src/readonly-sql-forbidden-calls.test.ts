// The forbidden-call FAMILIES: a statement that reads like a read and mutates the server, the
// notification queue, the replication stream or the transaction id. Split from
// `readonly-sql.test.ts` at the 500-line ceiling — the table is its own subject, and the last
// case in this file is the one that keeps it honest: the catalogs beside them stay readable.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { assertReadOnlyQuery } from './readonly-sql';

const refusal = { code: 'X_MCP_QUERY_REJECTED' };

/**
 * The thrown value as what it is, so a test can read `cause`/`fix` rather than a message. The
 * miss is an assertion and never a `throw new Error`: `expect.unreachable` is this repo's idiom,
 * and it returns `never`, which is what narrows `thrown` below. Declared here rather than imported
 * from a sibling suite — a test file that imports another test file runs it.
 */
const caught = (fn: () => unknown): UltimateError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!isUltimateError(thrown)) expect.unreachable('expected the call to throw an UltimateError');
  return thrown;
};

/**
 * `NOTIFY`, server control and the replication stream: three bans this file already makes in
 * another spelling. `notify`/`listen`/`unlisten` are write keywords, `pg_terminate_backend` and
 * `pg_cancel_backend` are already listed, and a consumed replication slot is `nextval`'s argument
 * exactly — a write that leaves no keyword behind and that one ROLLBACK does not undo.
 */
describe('a call that mutates the server, the queue or the replication stream is refused', () => {
  test('NOTIFY spelled as a call, which the keyword scan tokenises as one word', () => {
    expect(caught(() => assertReadOnlyQuery("select pg_notify('chan', 'payload')"))).toMatchObject(
      refusal,
    );
  });

  test('server control, the family pg_terminate_backend already established', () => {
    for (const sql of [
      'select pg_reload_conf()',
      'select pg_rotate_logfile()',
      'select pg_switch_wal()',
      'select pg_promote()',
      'select pg_wal_replay_pause()',
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('a replication slot, consumed irreversibly by a statement that reads like a read', () => {
    for (const sql of [
      "select pg_create_physical_replication_slot('s')",
      "select pg_create_logical_replication_slot('s', 'pgoutput')",
      "select pg_drop_replication_slot('s')",
      "select pg_replication_slot_advance('s', '0/0')",
      "select pg_logical_slot_get_changes('s', null, null)",
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('the writing half of the file family whose reading half was already banned', () => {
    for (const sql of [
      "select pg_file_write('/tmp/x', 'y', false)",
      "select pg_file_unlink('/tmp/x')",
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('a call that assigns a transaction id, which a ROLLBACK does not return', () => {
    for (const sql of [
      'select txid_current()',
      // The family is the unit: the `_if_assigned` spelling is refused with it rather than
      // argued about, which is the same trade `pg_sleep_for` is refused under.
      'select txid_current_if_assigned()',
      'select pg_current_xact_id()',
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('the catalog beside them is still readable, and so is a column sharing a prefix', () => {
    for (const sql of [
      'select * from pg_replication_slots',
      'select * from pg_stat_replication',
      'select pg_current_wal_lsn()',
      'select pg_notify_count from metrics',
      "select 'pg_notify' as note",
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });
});
