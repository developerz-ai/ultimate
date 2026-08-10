import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { describeJobs, getJob, job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';

/** Minimal Standard Schema so these tests do not depend on the shipped provider's surface. */
function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface OrgInput {
  readonly orgId: string;
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not-an-ultimate-error:${String(error)}`;
  }
};

let notify: JobHandle<OrgInput>;
let driver: JobDriver;

beforeEach(() => {
  resetJobs();
  resetJobsFacade();
  resetJobDriver();
  driver = createMemoryDriver();
  notify = job<OrgInput>({
    name: 'notifySubscribers',
    input: passthrough<OrgInput>(),
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 3, backoff: 'exponential' },
    run: () => Promise.resolve(),
  });
});

// The driver is process-global: leaving one installed makes the next file in this bun process
// enqueue into a dead queue instead of doing whatever it meant to do.
afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe('handle.enqueue', () => {
  test('queues a row under the handle own idempotency key, and dedupes a repeat', async () => {
    setJobDriver(driver);

    const first = await notify.enqueue({ orgId: 'org-1' });
    expect(first.deduped).toBe(false);

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('notifySubscribers');
    expect(rows[0]?.queue).toBe('default');
    expect(rows[0]?.idempotencyKey).toBe('notify:org-1');
    expect(rows[0]?.maxAttempts).toBe(3);

    const second = await notify.enqueue({ orgId: 'org-1' });
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });

  test('honours a driver installed after the first handle was built', async () => {
    // The fallback facade reads `jobDriver()` per call, so boot order cannot strand an enqueue.
    setJobDriver(driver);
    await notify.enqueue({ orgId: 'org-late' });
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });

  test('fails with X_DRIVER_UNAVAILABLE when no driver is installed', async () => {
    expect(await codeOf(notify.enqueue({ orgId: 'org-1' }))).toBe('X_DRIVER_UNAVAILABLE');
  });
});

describe('handle.as', () => {
  test('stamps tenantId from the actor org so per-tenant limits apply', async () => {
    setJobDriver(driver);
    await notify.as({ orgId: 'org-7' }, { orgId: 'org-7' });

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows[0]?.tenantId).toBe('org-7');
  });

  test('leaves an explicitly passed tenantId alone', async () => {
    setJobDriver(driver);
    await notify.as({ orgId: 'org-7' }, { orgId: 'org-7' }, { tenantId: 'org-override' });

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows[0]?.tenantId).toBe('org-override');
  });

  test('an actor with no org leaves the row untenanted — the limiter buckets it globally', async () => {
    setJobDriver(driver);
    await notify.as(null, { orgId: 'org-1' });

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows[0]?.tenantId).toBeUndefined();
  });

  test('queues rather than running the handler inline — the queue is the execution surface', async () => {
    setJobDriver(driver);
    let ran = false;
    const audit = job<OrgInput>({
      name: 'auditOrg',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `audit:${orgId}`,
      retry: { attempts: 1 },
      run: () => {
        ran = true;
        return Promise.resolve();
      },
    });

    await audit.as({ orgId: 'org-7' }, { orgId: 'org-7' });

    expect(ran).toBe(false);
    expect(((await driver.introspect?.list({ name: 'auditOrg' })) ?? []).length).toBe(1);
  });
});

describe('describe', () => {
  test('describeJobs() is the handles own projection, name-sorted', () => {
    job<OrgInput>({
      name: 'archiveOrg',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `archive:${orgId}`,
      retry: { attempts: 5, backoff: 'linear' },
      queue: 'maintenance',
      run: () => Promise.resolve(),
    });

    // Pinned literally: `x.manifest.json` is committed and diffed, so this shape moving is a
    // change to every app's build output, not just to this package.
    expect(describeJobs()).toEqual([
      {
        name: 'archiveOrg',
        input: { vendor: 'ultimate-test' },
        queue: 'maintenance',
        retry: { attempts: 5, backoff: 'linear' },
        steps: [],
      },
      {
        name: 'notifySubscribers',
        input: { vendor: 'ultimate-test' },
        queue: 'default',
        retry: { attempts: 3, backoff: 'exponential' },
        steps: [],
      },
    ]);
  });

  test('handle.describe() and describeJobs() agree', () => {
    expect(describeJobs()).toEqual([notify.describe()]);
  });

  test('backoff falls back to the default when the definition omits it', () => {
    resetJobs();
    const sweep = job<OrgInput>({
      name: 'sweep',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `sweep:${orgId}`,
      retry: { attempts: 2 },
      run: () => Promise.resolve(),
    });
    expect(sweep.describe().retry).toEqual({ attempts: 2, backoff: 'exponential' });
  });
});

describe('an unregistered job', () => {
  // `registerJobs(module)` is what gives a job its export name; `job()` on its own is unchanged,
  // and must stay so — 1.0.0 semver, and every existing caller declares without registering.
  test('still takes a positional name and is still enqueueable under it', async () => {
    resetJobs();
    setJobDriver(driver);
    const orphan = job<OrgInput>({
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `orphan:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    expect(orphan.name).toMatch(/^anonymous-job-\d+$/);
    expect(getJob(orphan.name)).toBe(orphan as JobHandle<unknown>);
    expect(orphan.describe().name).toBe(orphan.name);

    await orphan.enqueue({ orgId: 'org-1' });
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows[0]?.name).toBe(orphan.name);
  });
});
