// The tenant proof against planted holes on the memory driver: each way past the repository guard
// — a child with no tenant, `crossTenant()`, a service actor, a hand-built cache key, a mail, a
// write by input id — reads crossed with its primitive named; a scoped read is proven, a public
// read is public with its write half kept, and a handler that never answers proves nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type PgliteClient, pgliteClient } from '@ultimat3/db';
import type { ExerciseRecord, TenantFinding } from './exercise-report';
import { proveOne, resetTenantApp, tenantlessRows, tpFiles } from './tenant-proof-fixture';
import { overwrittenDocs, proveSql, releaseSql, useSql } from './tenant-proof-sql-fixture';
import './tenant-proof-holes-fixture';
import './tenant-proof-sweep-fixture';
import { testName } from './test-types';

/** The findings of a crossed record — an empty list for any other verdict, which fails the caller. */
const findingsOf = (record: ExerciseRecord): readonly TenantFinding[] =>
  record.tenant?.verdict === 'crossed' ? record.tenant.findings : [];

/** A crossed record whose positive control answered: the hole is real, not a broken fixture. */
const expectCrossed = (record: ExerciseRecord, name: string, kind: ExerciseRecord['kind']) => {
  expect({ name: record.name, kind: record.kind, outcome: record.outcome }).toEqual({
    name,
    kind,
    outcome: 'reached',
  });
  expect(record.tenant?.verdict).toBe('crossed');
  return findingsOf(record);
};

/** The ids of tp_files rows a write moved to `url` — the rows the finding must name. */
const renamedTo = async (url: string): Promise<readonly unknown[]> =>
  (await tenantlessRows(tpFiles)).filter((row) => row['url'] === url).map((row) => row['id']);

beforeEach(resetTenantApp);

describe(testName('unit', 'tenant proof: every planted hole is crossed'), () => {
  test('a child with no tenant column, read by id, leaks its url into the output', async () => {
    const findings = expectCrossed(await proveOne('tpChildRead'), 'tpChildRead', 'action');
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'X_TENANT_LEAK', leg: 'before', path: 'output.url' }),
    );
  });

  test('the same child read through a query is crossed, named as the query', async () => {
    const findings = expectCrossed(await proveOne('tpChildQuery'), 'tpChildQuery', 'query');
    const leak = findings.find((finding) => finding.code === 'X_TENANT_LEAK');
    expect(leak?.path).toMatch(/^output\b.*url$/);
  });

  test('crossTenant() under a policy that is not public leaks', async () => {
    const findings = expectCrossed(await proveOne('tpCrossRead'), 'tpCrossRead', 'action');
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'X_TENANT_LEAK', path: 'output.label' }),
    );
  });

  test('a service actor minted from the input org leaks', async () => {
    const findings = expectCrossed(await proveOne('tpServiceRead'), 'tpServiceRead', 'action');
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'X_TENANT_LEAK', path: 'output.label' }),
    );
  });

  test('a cache key without the tenant leaks on the leg after A filled it, never before', async () => {
    const findings = expectCrossed(await proveOne('tpCachedRead'), 'tpCachedRead', 'action');
    expect(findings.map((finding) => [finding.code, finding.leg])).toEqual([
      ['X_TENANT_LEAK', 'after'],
    ]);
  });

  test('a mail to A’s owner is a leak in an effect, with nothing in the output', async () => {
    const findings = expectCrossed(await proveOne('tpMailOwner'), 'tpMailOwner', 'action');
    const leaks = findings.filter((finding) => finding.code === 'X_TENANT_LEAK');
    expect(leaks.length).toBeGreaterThan(0);
    for (const leak of leaks) expect(leak.path).toStartWith('effect.');
  });

  test('a write by input id is X_TENANT_WRITE_CROSSED naming the table and A’s row', async () => {
    const findings = expectCrossed(await proveOne('tpRenameFile'), 'tpRenameFile', 'action');
    const renamed = await renamedTo('https://renamed.example.test/by-caller');
    expect(renamed).toHaveLength(1);
    expect(findings).toContainEqual({
      code: 'X_TENANT_WRITE_CROSSED',
      leg: 'before',
      table: 'tp_files',
      id: String(renamed[0]),
    });
  });

  test('the same write from a job body is crossed, named as the job', async () => {
    const findings = expectCrossed(await proveOne('tpRenameFileJob'), 'tpRenameFileJob', 'job');
    const renamed = await renamedTo('https://renamed.example.test/by-worker');
    expect(renamed).toHaveLength(1);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'X_TENANT_WRITE_CROSSED',
        table: 'tp_files',
        id: renamed[0],
      }),
    );
  });
});

describe(testName('unit', 'tenant proof: what must stay green'), () => {
  test('a read the guard scopes is proven', async () => {
    const record = await proveOne('tpScopedRead');
    expect(record.outcome).toBe('reached');
    expect(record.tenant).toEqual({ verdict: 'proven' });
  });

  test('a public read is public with a reason, though the same read under a role leaks', async () => {
    const record = await proveOne('tpPublicFile');
    expect(record.outcome).toBe('reached');
    expect(record.tenant?.verdict).toBe('public');
    expect(record.tenant?.verdict === 'public' && record.tenant.reason.trim()).not.toBe('');
  });

  test('a public write by input id is still crossed: the write half is never skipped', async () => {
    const findings = expectCrossed(await proveOne('tpPublicRename'), 'tpPublicRename', 'action');
    expect(findings.map((finding) => finding.code)).toContain('X_TENANT_WRITE_CROSSED');
    expect(findings.map((finding) => finding.code)).not.toContain('X_TENANT_LEAK');
  });

  test('a child declared shared belongs to no tenant: reading it by id is proven', async () => {
    const record = await proveOne('tpLinkRead');
    expect(record.outcome).toBe('reached');
    expect(record.tenant).toEqual({ verdict: 'proven' });
  });

  test('a job sweeping every org under crossTenant() is public, naming its reason', async () => {
    const record = await proveOne('tpVaultSweep');
    expect(record.outcome).toBe('reached');
    expect(record.tenant).toEqual({
      verdict: 'public',
      reason: expect.stringContaining('the nightly vault report covers every org'),
    });
  });

  test('the same sweep with no crossTenant() declared is crossed', async () => {
    const findings = expectCrossed(await proveOne('tpFileSweep'), 'tpFileSweep', 'job');
    expect(findings).toContainEqual(expect.objectContaining({ code: 'X_TENANT_LEAK' }));
  });

  test('a handler that always throws is unreached and unproven, never proven', async () => {
    const record = await proveOne('tpAlwaysThrows');
    expect(record.outcome).toBe('unreached');
    expect(record.tenant?.verdict).toBe('unproven');
    expect(record.tenant?.verdict === 'unproven' && record.tenant.reason.trim()).not.toBe('');
  });
});

/** A cold PGlite boot, the migration and two passes. */
const PGLITE_MS = 60_000;

describe(testName('unit', 'tenant proof: raw SQL, on PGlite'), () => {
  let pglite: PgliteClient | undefined;
  beforeAll(async () => {
    pglite = pgliteClient();
    await useSql(pglite);
  }, PGLITE_MS);
  afterAll(async () => {
    releaseSql();
    await pglite?.close();
  });

  test(
    'a raw-SQL read by input id leaks',
    async () => {
      const findings = expectCrossed(await proveSql('tpsRawRead', 1), 'tpsRawRead', 'action');
      expect(findings).toContainEqual(
        expect.objectContaining({ code: 'X_TENANT_LEAK', path: 'output.body' }),
      );
    },
    PGLITE_MS,
  );

  test(
    'a raw-SQL update by input id is crossed, naming the table and the row',
    async () => {
      const findings = expectCrossed(await proveSql('tpsRawWrite', 2), 'tpsRawWrite', 'action');
      const overwritten = await overwrittenDocs();
      expect(overwritten).toHaveLength(1);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'X_TENANT_WRITE_CROSSED',
          table: 'tps_docs',
          id: overwritten[0],
        }),
      );
    },
    PGLITE_MS,
  );

  test(
    'the same row through the scoped repository is proven',
    async () => {
      const record = await proveSql('tpsScopedRead', 3);
      expect(record.outcome).toBe('reached');
      expect(record.tenant).toEqual({ verdict: 'proven' });
    },
    PGLITE_MS,
  );
});
