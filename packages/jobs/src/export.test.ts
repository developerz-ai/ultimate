// `exportRows()` is a factory over `job()`, so what this file pins is the DECLARATION: the handle
// it returns is a real registered job, the artifact prefix is what dedupes a second enqueue, and a
// declaration that cannot produce a readable artifact is refused where it was written rather than
// discovered one statement into a pass.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { type ExportDefinition, exportRows } from './export';
import { memoryExportSink } from './export-sink';
import { getJob, isJobHandle, resetJobs } from './job';

const rows = entity('export_factory_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;
interface Input {
  readonly orgId: string;
  readonly exportId: string;
}

const ORG = '00000000-0000-7000-8000-0000000000a1';

const definition = (
  over: Partial<ExportDefinition<Row, Input>> = {},
): ExportDefinition<Row, Input> => ({
  name: 'orders-export',
  input: t.object({ orgId: t.string, exportId: t.string }),
  tenant: ({ orgId }) => orgId,
  prefix: ({ orgId, exportId }) => `exports/${orgId}/${exportId}`,
  source: () => tableFor(rows, memoryRepo(rows, [])).where({ orgId: ORG }),
  format: 'csv',
  columns: ['id', 'title'],
  row: (record) => ({ id: record.id, title: record.title }),
  sink: memoryExportSink(),
  ...over,
});

const codeOf = (over: Partial<ExportDefinition<Row, Input>>): string => {
  try {
    exportRows<Row, Input>(definition(over));
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
  }
  return 'declared';
};

beforeEach(() => {
  resetJobs();
});

describe('the factory', () => {
  test('returns a registered job handle keyed by the declared name', () => {
    const handle = exportRows<Row, Input>(
      definition({ queue: 'reports', retry: { attempts: 7, backoff: 'fixed' } }),
    );

    expect(isJobHandle(handle)).toBe(true);
    expect(getJob('orders-export')).toBe(handle);
    expect(handle.queue).toBe('reports');
    expect(handle.retry.attempts).toBe(7);
  });

  test('the artifact prefix IS the idempotency key, so two runs never race over one artifact', () => {
    const handle = exportRows<Row, Input>(definition());
    expect(handle.idempotencyKeyFor({ orgId: ORG, exportId: 'e1' })).toBe(
      `orders-export:exports/${ORG}/e1`,
    );
    // A different artifact is a different run; the same artifact is the same run.
    expect(handle.idempotencyKeyFor({ orgId: ORG, exportId: 'e2' })).not.toBe(
      handle.idempotencyKeyFor({ orgId: ORG, exportId: 'e1' }),
    );
  });

  test('the declared tenant is what the pass runs under, never the workers', () => {
    // The security boundary of the whole feature: an export concentrates one tenant's rows into a
    // single downloadable object.
    const handle = exportRows<Row, Input>(definition());
    expect(handle.tenantFor({ orgId: ORG, exportId: 'e1' })).toBe(ORG);

    resetJobs();
    const none = exportRows<Row, Input>(definition({ tenant: 'none' }));
    expect(none.tenantFor({ orgId: ORG, exportId: 'e1' })).toBeUndefined();
  });
});

describe('a declaration that cannot produce a readable artifact is refused', () => {
  test('a batch that is not a whole number of rows', () => {
    for (const batch of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf({ batch })).toBe('X_INVARIANT');
      resetJobs();
    }
  });

  test('a part bound no page could fit in', () => {
    for (const maxPartBytes of [0, -1, 1.5]) {
      expect(codeOf({ maxPartBytes })).toBe('X_INVARIANT');
      resetJobs();
    }
  });

  test('a format nothing encodes', () => {
    expect(codeOf({ format: 'parquet' as 'csv' })).toBe('X_INVARIANT');
  });

  test('no columns, or the same column twice', () => {
    // No columns is an artifact with no data in it and both encoders would write one happily; a
    // repeat writes the same cell twice under two headers that read as different fields.
    expect(codeOf({ columns: [] })).toBe('X_INVARIANT');
    resetJobs();
    expect(codeOf({ columns: ['id', 'id'] })).toBe('X_INVARIANT');
  });

  test('a rate nothing can be paced at', () => {
    expect(codeOf({ rate: 0 })).toBe('X_INVARIANT');
  });

  test('the refusal happens BEFORE job() ran, so the name is still free', () => {
    expect(codeOf({ columns: [] })).toBe('X_INVARIANT');
    expect(getJob('orders-export')).toBeUndefined();
    expect(isJobHandle(exportRows<Row, Input>(definition()))).toBe(true);
  });
});
