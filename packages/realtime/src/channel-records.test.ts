// A committed change → which channel topic owes which record update. The feed names the TABLE,
// the store keys by the record TYPE and key, and the params come off the row itself.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { channel } from './channel-decl';
import { updatesFor } from './channel-records';
import { clearChannels } from './channel-registry';

const accounts = entity('channel_records_account', {
  table: 'legacy_accounts',
  columns: { id: uuid().primaryKey(), orgId: uuid(), name: text() },
});

afterAll(() => {
  clearRegistry();
  clearChannels();
});

const feed = channel('accounts', {
  params: ['orgId'],
  catchUp: { name: 'accounts' },
  records: [accounts],
});

const change = (over: Partial<ChangeEvent>): ChangeEvent => ({
  entity: 'legacy_accounts',
  op: 'insert',
  before: null,
  after: null,
  lsn: '0000000000000001',
  txid: '1',
  orgId: null,
  at: 0,
  ...over,
});

const row = (orgId: string, name = 'n') => ({ id: 'a1', orgId, name });

describe('updatesFor()', () => {
  test('an insert adopts the row on the topic its params name, typed and keyed', () => {
    const [update, ...rest] = updatesFor([feed], change({ after: row('o1') }));
    expect(rest).toEqual([]);
    expect(String(update?.topic)).toBe('accounts.o1');
    expect(update?.adopt).toEqual([{ type: 'channel_records_account', key: 'a1', row: row('o1') }]);
    expect(update?.remove).toEqual([]);
  });

  test('the feed names the table, and a renamed table still routes', () => {
    expect(
      updatesFor([feed], change({ entity: 'channel_records_account', after: row('o1') })),
    ).toEqual([]);
  });

  test('an update that moved the row between params removes it from the old topic', () => {
    const updates = updatesFor(
      [feed],
      change({ op: 'update', before: row('o1'), after: row('o2') }),
    );
    expect(
      updates.map((update) => [String(update.topic), update.adopt.length, update.remove]),
    ).toEqual([
      ['accounts.o2', 1, []],
      ['accounts.o1', 0, [{ type: 'channel_records_account', key: 'a1' }]],
    ]);
  });

  test('an update in place is one adopt, not an adopt and a remove', () => {
    const updates = updatesFor(
      [feed],
      change({ op: 'update', before: row('o1'), after: row('o1', 'm') }),
    );
    expect(updates.map((update) => String(update.topic))).toEqual(['accounts.o1']);
  });

  test('a delete removes by key from the topic the old image names', () => {
    const updates = updatesFor([feed], change({ op: 'delete', before: row('o1') }));
    expect(updates.map((update) => [String(update.topic), update.remove])).toEqual([
      ['accounts.o1', [{ type: 'channel_records_account', key: 'a1' }]],
    ]);
  });

  test('a key-only delete image names no topic, so nothing is guessed', () => {
    expect(updatesFor([feed], change({ op: 'delete', before: { id: 'a1' } }))).toEqual([]);
  });

  test('a table no channel lists is nobody’s', () => {
    expect(updatesFor([feed], change({ entity: 'other', after: row('o1') }))).toEqual([]);
  });
});
