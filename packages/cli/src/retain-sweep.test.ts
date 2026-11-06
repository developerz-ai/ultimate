// The `manifest` step's retention half: a `retain` entity no `purge()` covers is red, with a fix
// naming the declaration to add; a covered app is green; a failed load says nothing here.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, timestamp, uuid } from '@ultimat3/entity';
import { purge, resetJobs, resetPurgeCoverage } from '@ultimat3/jobs';
import { retainUnsweptFindings } from './retain-sweep';

const loaded = async () => ({ findings: [] });

afterAll(() => {
  clearRegistry();
  resetJobs();
  resetPurgeCoverage();
});

describe('unit · X_ENTITY_RETAIN_UNSWEPT', () => {
  entity('rs_events', {
    columns: { id: uuid().primaryKey(), createdAt: timestamp().defaultNow() },
    indexes: [{ on: ['createdAt'] }],
    retain: { after: '90d', on: 'createdAt' },
  });

  test('a retain entity with no purge is red, and the fix names the declaration', async () => {
    const findings = await retainUnsweptFindings('/app', loaded);
    expect(findings.map((finding) => finding.code)).toEqual(['X_ENTITY_RETAIN_UNSWEPT']);
    expect(findings[0]?.fix).toStartWith(
      "export const retention = purge({ entities: 'declared' })",
    );
  });

  test("purge({ entities: 'declared' }) covers it", async () => {
    purge({ name: 'rs.purge', entities: 'declared' });
    expect(await retainUnsweptFindings('/app', loaded)).toEqual([]);
  });

  test('a load that failed reports nothing here', async () => {
    const failed = async () => ({
      findings: [{ code: 'X_APP_LOAD_FAILED', cause: 'broken', fix: 'x verify --json' }],
    });
    expect(await retainUnsweptFindings('/app', failed, () => ['rs_events'])).toEqual([]);
  });
});
