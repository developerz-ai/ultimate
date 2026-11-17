// A window's org is the window's TENANT, and nothing else. It used to fall back to an input
// property spelled `orgId`, a second answer beside `change-tenant.ts`'s: an untenanted window whose
// input happened to carry one filtered the change feed by it, so a change its own read returns —
// the read runs with no tenant — was dropped before any predicate saw it.

import { describe, expect, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import type { JsonValue } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { canAffect } from './matcher-bridge';
import { queryEntry } from './query-window';

const definition: LiveQueryDefinition = {
  name: 'boardFeed',
  entities: ['boards'],
  snapshot: async () => ({ rows: [], lsn: '' }),
  visible: () => true,
  matcher: () => ({ entities: ['boards'], match: () => ({ patches: [], refill: false }) }),
};

const entryFor = (input: JsonValue, tenant?: string | null) =>
  queryEntry(
    'boardFeed:1',
    definition,
    input,
    definition.matcher(input),
    tenant === undefined ? undefined : { tenant },
  );

const changeIn = (orgId: string | null): ChangeEvent => ({
  table: 'boards',
  op: 'insert',
  before: null,
  after: { id: 'b1', orgId: orgId ?? '' },
  lsn: '0000000000000001' + '00000000',
  txid: '1',
  orgId,
  at: 1_000,
  write: null,
});

describe('unit · a window reads its org off its tenant alone', () => {
  test('an untenanted window carries orgId null, whatever its input names', () => {
    const entry = entryFor({ orgId: 'o1' });
    expect(entry.shape.orgId).toBeNull();
    // ...so a change in another org still reaches the matcher, as the window's own read would.
    expect(canAffect(entry.shape, changeIn('o2'))).toBe(true);
  });

  test("a tenanted window carries its tenant, never the input's orgId", () => {
    const entry = entryFor({ orgId: 'o-input' }, 'o-tenant');
    expect(entry.shape.orgId).toBe('o-tenant');
    expect(canAffect(entry.shape, changeIn('o-input'))).toBe(false);
    expect(canAffect(entry.shape, changeIn('o-tenant'))).toBe(true);
  });

  test('an explicit null tenant is untenanted too', () => {
    expect(entryFor({ orgId: 'o1' }, null).shape.orgId).toBeNull();
  });
});
