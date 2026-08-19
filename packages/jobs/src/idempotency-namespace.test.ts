// J1: the idempotency key namespace is per JOB and per TENANT, never global. The failure this pins
// is silent — no error, no dead letter, one healthy-looking row — so it is the first test in the
// file. The tenant half is the same failure with a second party in it: tenant B's work never runs
// AND tenant B's caller receives tenant A's job id, which every id-addressed surface accepts.

import { describe, expect, test } from 'bun:test';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_ENQUEUE, SQL_FIND_LIVE_BY_KEY, SQL_JOBS_TABLE } from './driver-pg-sql';

const enqueue = (name: string, key: string, tenantId?: string) => ({
  name,
  queue: 'default',
  input: { userId: 42 },
  idempotencyKey: key,
  maxAttempts: 3,
  ...(tenantId === undefined ? {} : { tenantId }),
});

describe('the idempotency namespace', () => {
  test('two DIFFERENT jobs sharing a natural key both run', async () => {
    // The scenario: team A ships sendWelcomeEmail with `user:${id}`, team B ships
    // provisionWorkspace six months later with the same natural key, one signup enqueues both.
    // Before this, the second enqueue deduped into the first job's row and returned ITS id — the
    // workspace was never provisioned, nothing was raised, and `x jobs ls` showed one healthy job.
    const driver = createMemoryDriver();

    const welcome = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    const workspace = await driver.enqueue(enqueue('provisionWorkspace', 'user:42'));

    expect(welcome.deduped).toBe(false);
    expect(workspace.deduped).toBe(false);
    expect(workspace.id).not.toBe(welcome.id);

    const queued = await driver.introspect?.list();
    expect(queued?.map((row) => row.name).sort()).toEqual([
      'provisionWorkspace',
      'sendWelcomeEmail',
    ]);
  });

  test('the SAME job with the same key still dedupes — the guarantee is unchanged', async () => {
    const driver = createMemoryDriver();
    const first = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    const second = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test('a completed job frees its key for the same job again', async () => {
    const driver = createMemoryDriver();
    const first = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    await driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 1000, workerId: 'w' });
    await driver.ack(first.id);

    const second = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    expect(second.deduped).toBe(false);
  });

  test('the pg driver looks the live row up by NAME as well as key', async () => {
    // The dedupe lookup has to match the index. One that did not would answer with whichever
    // stranger held the key, and `{ deduped: true, id: <someone else's> }` is the data loss.
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        calls.push({ sql, params });
        // `do nothing` fired: no inserted row comes back, then the live-row lookup answers.
        if (sql === SQL_ENQUEUE) return Promise.resolve([] as readonly R[]);
        return Promise.resolve([{ id: 'existing', run_id: 'run' }] as unknown as readonly R[]);
      },
    };
    const driver = createPgDriver({ executor });

    const result = await driver.enqueue(enqueue('provisionWorkspace', 'user:42'));

    expect(result.deduped).toBe(true);
    const lookup = calls.find((call) => call.sql === SQL_FIND_LIVE_BY_KEY);
    expect(lookup?.params).toEqual(['provisionWorkspace', 'user:42', null]);
  });
});

// S1. The key was scoped by name and NOT by tenant, while the row already carried `tenant_id` as
// `$9` of the same insert. Every natural key the docs suggest — `invoice:${input.invoiceId}`,
// `order:${input.orderNumber}` — is unique only WITHIN a tenant.
describe('the idempotency namespace is per tenant', () => {
  test('two tenants deriving the same natural key both run', async () => {
    // Tenant A has a live `invoice:1001`. Tenant B enqueues its own `invoice:1001`. Before this,
    // `do nothing` fired, the lookup found A's row, and B got `{ deduped: true, id: A.id }`: B's
    // work never ran, nothing was raised, and B's caller held a job id belonging to A.
    const driver = createMemoryDriver();

    const a = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-a'));
    const b = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-b'));

    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);
    // The id handed back is the caller's OWN row — the half that turns a missed run into a
    // cross-tenant handle, because `cancel(jobId)` takes an id with no tenant predicate.
    expect((await driver.introspect?.job(b.id))?.tenantId).toBe('org-b');
    expect((await driver.introspect?.list())?.length).toBe(2);
  });

  test('the SAME tenant with the same key still dedupes — the guarantee is unchanged', async () => {
    const driver = createMemoryDriver();
    const first = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-a'));
    const second = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-a'));

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test('a tenantless enqueue is its own namespace, in both directions', async () => {
    const driver = createMemoryDriver();
    const shared = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001'));
    const tenanted = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-a'));
    expect(tenanted.deduped).toBe(false);
    expect(tenanted.id).not.toBe(shared.id);
    // And two tenantless enqueues still collapse: `coalesce(tenant_id, '')` is one namespace.
    const again = await driver.enqueue(enqueue('sendInvoice', 'invoice:1001'));
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(shared.id);
  });

  test('onConflict: error raises for the same tenant and stays silent across tenants', async () => {
    const driver = createMemoryDriver();
    await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-a'));
    // `createMemoryDriver().enqueue` throws synchronously, so this cannot be `rejects`.
    let sameTenant: unknown;
    try {
      await driver.enqueue({
        ...enqueue('sendInvoice', 'invoice:1001', 'org-a'),
        onConflict: 'error' as const,
      });
    } catch (thrown) {
      sameTenant = thrown;
    }
    expect(sameTenant).toBeUltimateError('X_JOB_DUPLICATE');
    const other = await driver.enqueue({
      ...enqueue('sendInvoice', 'invoice:1001', 'org-b'),
      onConflict: 'error' as const,
    });
    expect(other.deduped).toBe(false);
  });

  test('the pg driver looks the live row up by tenant as well as name and key', async () => {
    // The lookup has to match the index. One that did not would answer with whichever stranger
    // held the key — and `{ deduped: true, id: <another tenant's> }` is the leak.
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        calls.push({ sql, params });
        if (sql === SQL_ENQUEUE) return Promise.resolve([] as readonly R[]);
        return Promise.resolve([{ id: 'existing', run_id: 'run' }] as unknown as readonly R[]);
      },
    };
    const driver = createPgDriver({ executor });

    await driver.enqueue(enqueue('sendInvoice', 'invoice:1001', 'org-b'));

    const lookup = calls.find((call) => call.sql === SQL_FIND_LIVE_BY_KEY);
    expect(lookup?.params).toEqual(['sendInvoice', 'invoice:1001', 'org-b']);
  });

  test('both statements name the tenant, and they name it the same way', async () => {
    // The conflict target must be the index expression exactly, or Postgres cannot infer it —
    // and a lookup keyed differently from the index answers a row the index did not reject.
    expect(SQL_ENQUEUE).toContain("on conflict (name, (coalesce(tenant_id, '')), idempotency_key)");
    expect(SQL_FIND_LIVE_BY_KEY).toContain("coalesce(tenant_id, '') = coalesce($3::text, '')");
    expect(SQL_JOBS_TABLE).toContain(
      "on x_jobs (name, (coalesce(tenant_id, '')), idempotency_key)",
    );
    // The strictly narrower index is DROPPED, not left beside the new one: kept, it would keep
    // enforcing exactly the cross-tenant collision this fixes.
    expect(SQL_JOBS_TABLE).toContain('drop index if exists x_jobs_name_idempotency_live_idx');
    expect(SQL_JOBS_TABLE).not.toMatch(/on x_jobs \(name, idempotency_key\)/);
  });
});
