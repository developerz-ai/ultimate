// Which tables a channel makes need REPLICA IDENTITY FULL: the `records` of a channel with params.

import { expect, test } from 'bun:test';
import type { Channel } from './channel-decl';
import { paramsChannelTables } from './pg-identity-tables';

/** Only the two fields the question reads; a real declaration is `channel-decl.test.ts`'s. */
const declared = (params: readonly string[], tables: readonly string[]): Channel =>
  ({ params, records: tables.map((table) => ({ table })) }) as unknown as Channel;

test('the records tables of every channel with params, deduped and sorted', () => {
  const tables = paramsChannelTables([
    declared(['orgId'], ['posts', 'comments']),
    declared(['roomId'], ['comments']),
  ]);
  expect(tables).toEqual(['comments', 'posts']);
});

test('a channel with no params has one topic, so its tables need nothing', () => {
  expect(paramsChannelTables([declared([], ['announcements'])])).toEqual([]);
});

test('a channel that carries no records names no table', () => {
  expect(paramsChannelTables([declared(['orgId'], [])])).toEqual([]);
});
