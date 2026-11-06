// A consumer removed is a stream nobody reads again, and nothing throws: breaking. Everything else
// about it is how it runs, not what a caller is promised — reported, never gating.

import { describe, expect, test } from 'bun:test';
import { diffManifest } from './diff';
import type { ChangeKind, ManifestChange } from './diff-change';
import { diffConsumers } from './diff-consumers';
import { fixtureManifest } from './diff-fixture';
import type { ConsumerFact } from './schema';
import { isManifest } from './schema';

const LEDGER: ConsumerFact = {
  name: 'ledgerFeed',
  queue: 'default',
  supervisor: 'ledgerFeed.supervisor',
  arm: 'ledgerFeed.arm',
  rearm: '* * * * *',
  batch: 100,
  lags: true,
};

const only = (changes: readonly ManifestChange[]): readonly [ChangeKind, string][] =>
  changes.map((change) => [change.kind, change.path]);

describe('unit · diffConsumers', () => {
  test('nothing moved, nothing reported', () => {
    expect(diffConsumers([LEDGER], [LEDGER])).toEqual([]);
  });

  test('a consumer removed is breaking, one added is additive', () => {
    expect(only(diffConsumers([LEDGER], []))).toEqual([['breaking', 'consumers.ledgerFeed']]);
    expect(only(diffConsumers([], [LEDGER]))).toEqual([['additive', 'consumers.ledgerFeed']]);
  });

  test('every field that moved is internal and named', () => {
    const after: ConsumerFact = {
      ...LEDGER,
      queue: 'bulk',
      rearm: '*/5 * * * *',
      batch: 50,
      lags: false,
    };
    expect(only(diffConsumers([LEDGER], [after]))).toEqual([
      ['internal', 'consumers.ledgerFeed.queue'],
      ['internal', 'consumers.ledgerFeed.rearm'],
      ['internal', 'consumers.ledgerFeed.batch'],
      ['internal', 'consumers.ledgerFeed.lags'],
    ]);
  });
});

describe('unit · the consumers section through diffManifest', () => {
  test('the last consumer leaving drops the key and still reports the removal', () => {
    const before = fixtureManifest({ consumers: [LEDGER] });
    const after = fixtureManifest();
    expect('consumers' in after).toBe(false);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((change) => change.path)).toEqual(['consumers.ledgerFeed']);
  });

  test('a file whose consumers is not an array is not a manifest', () => {
    expect(isManifest({ ...fixtureManifest(), consumers: {} })).toBe(false);
    expect(isManifest(fixtureManifest({ consumers: [LEDGER] }))).toBe(true);
  });
});
