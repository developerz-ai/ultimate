// A committed change → which channel topic owes which record update. The feed names the TABLE,
// the store keys by the record TYPE and key, and the params come off the row itself.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { channel } from './channel-decl';
import { skippedRemovals, updatesFor } from './channel-records';
import { clearChannels } from './channel-registry';
import { OPEN_POLICY } from './policy-fake-fixture';

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
  policy: OPEN_POLICY,
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
  write: null,
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

// Under the default replica identity a DELETE's old image is the key alone, so a channel with
// params cannot name the topic the row left. The removal is lost — and was lost silently.
describe('a removal the old image cannot route', () => {
  test('is counted; a whole old image routes it and counts nothing', () => {
    const before = skippedRemovals();

    const routed = updatesFor([feed], change({ op: 'delete', before: row('o1') }));
    expect(routed.map((update) => update.remove.length)).toEqual([1]);
    expect(skippedRemovals()).toBe(before);

    const lost = updatesFor([feed], change({ op: 'delete', before: { id: 'a1' } }));
    expect(lost).toEqual([]);
    expect(skippedRemovals()).toBe(before + 1);
  });

  test('a channel with no params routes every delete, so nothing is skipped', () => {
    const everyone = channel('accounts-all', {
      params: [],
      catchUp: { name: 'accountsAll' },
      policy: OPEN_POLICY,
      records: [accounts],
    });
    const before = skippedRemovals();

    const routed = updatesFor([everyone], change({ op: 'delete', before: { id: 'a1' } }));

    expect(routed).toHaveLength(1);
    expect(skippedRemovals()).toBe(before);
  });
});
