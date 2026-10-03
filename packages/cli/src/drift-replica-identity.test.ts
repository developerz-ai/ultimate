// The drift step's read of which tables need REPLICA IDENTITY FULL: the generator's own set, its
// own refusal as a finding, and nothing else swallowed.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { QuerySubscribesUnknownError } from './db-subscribes';
import { appReplicaIdentity, wantedReplicaIdentity } from './drift-replica-identity';
import { MIGRATIONS_DIR } from './migrations';

describe('unit · the identity the drift step expects', () => {
  test('the wanted tables come back as a set', () => {
    const wanted = wantedReplicaIdentity(() => ['posts', 'posts'], new Set(['posts']));
    expect('tables' in wanted && [...wanted.tables]).toEqual(['posts']);
  });

  test('the subscribes: refusal x db gen raises is a finding at the migrations directory', () => {
    const wanted = wantedReplicaIdentity(() => {
      throw new QuerySubscribesUnknownError({ query: 'feed', table: 'pots', tables: new Set() });
    }, new Set());
    if (!('finding' in wanted)) return expect.unreachable('the refusal became a finding');
    expect(wanted.finding.code).toBe('X_QUERY_SUBSCRIBES_UNKNOWN');
    expect(wanted.finding.at).toBe(MIGRATIONS_DIR);
  });

  // Any other throw is a defect in this process; reading it as a finding would hide it.
  test('any other throw is rethrown', () => {
    const defect = new UltimateError({ code: 'X_CLI_UNEXPECTED', cause: 'probe', fix: 'x doctor' });
    expect(() =>
      wantedReplicaIdentity(() => {
        throw defect;
      }, new Set()),
    ).toThrow(defect);
  });

  // The default reads the process's own registries — the ones `loadApp` fills — and filters to
  // declared tables exactly as `x db gen` does: a table no entity declares is never expected.
  test('the app default expects nothing over a table no entity declares', () => {
    expect(appReplicaIdentity(new Set())).toEqual([]);
  });
});
