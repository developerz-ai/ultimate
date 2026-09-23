// A replicated tuple becomes the row its ENTITY declares, by `@ultimat3/entity`'s own decoder —
// never by guessing from column names, which is what this file used to test.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, entityForTable, money, text } from '@ultimat3/entity';
import { entityRow } from './pg-entity-row';
import type { PgRelation } from './pgoutput';

function ensureInvoices(): void {
  if (entityForTable('er_invoices') !== undefined) return;
  entity('er_invoices', {
    columns: { id: text().primaryKey(), memo: text(), total: money().nullable() },
  });
}

const relationOf = (replicaIdentity: string): PgRelation => ({
  oid: 1,
  schema: 'public',
  name: 'er_invoices',
  replicaIdentity,
  columns: [
    { key: true, name: 'id', typeOid: 25, typeMod: -1 },
    { key: false, name: 'memo', typeOid: 25, typeMod: -1 },
    { key: false, name: 'total_minor', typeOid: 20, typeMod: -1 },
    { key: false, name: 'total_currency', typeOid: 25, typeMod: -1 },
  ],
});

describe('entityRow', () => {
  test('decodes by the entity: a nullable money column is null, never half a Money', () => {
    ensureInvoices();
    const row = entityRow(
      relationOf('f'),
      { id: 'i1', memo: 'x', total_minor: null, total_currency: null },
      'after',
    );
    expect(row).toEqual({ id: 'i1', memo: 'x', total: null });
  });

  test('money columns fold into the declared property', () => {
    ensureInvoices();
    const row = entityRow(
      relationOf('f'),
      { id: 'i2', memo: 'y', total_minor: 1990, total_currency: 'USD' },
      'after',
    );
    expect(row['total']).toEqual({ minor: 1990, currency: 'USD' });
  });

  test('a key-only before image is the key alone — its NULLs are not the row', () => {
    ensureInvoices();
    const before = { id: 'i3', memo: null, total_minor: null, total_currency: null };
    expect(entityRow(relationOf('d'), before, 'before')).toEqual({ id: 'i3' });
  });

  test('a relation no entity declares is refused by name', () => {
    const unknown = { ...relationOf('f'), name: 'er_nobody' };
    let code = 'did not throw';
    try {
      entityRow(unknown, { id: 'x' }, 'after');
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'uncoded';
    }
    expect(code).toBe('X_REPLICATION_PROTOCOL');
  });
});
