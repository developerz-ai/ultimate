import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { describeJobs, getJob, job, registeredJobs, resetJobs } from './job';
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

/**
 * What `describeJob` publishes for a schema no provider can introspect — `passthrough` above is
 * exactly that case. A real `t.object({...})` converts to a real JSON Schema instead; the test
 * below pins both halves, because "the manifest carries a schema" is the whole reason the field
 * exists and a permissive node everywhere would satisfy the shape while carrying no fact.
 */
const PERMISSIVE = { type: 'object', additionalProperties: true } as const;

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
    tenant: 'none',
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

// The same shape as the `retry.attempts >= 1` backstop beside it, and for the same reason: a
// `concurrency: 0` is not "no cap", it is a fleet slot table that grants nothing — `acquire`
// answers `false` forever, with no log line, and the job is permanently unrunnable.
describe('job() refuses a concurrency that can never be filled', () => {
  const declare =
    (concurrency: number): (() => JobHandle<OrgInput>) =>
    () =>
      job<OrgInput>({
        tenant: 'none',
        name: `capped-${String(concurrency)}`,
        concurrency,
        input: passthrough<OrgInput>(),
        idempotencyKey: ({ orgId }) => `capped:${orgId}`,
        retry: { attempts: 1 },
        run: () => Promise.resolve(),
      });

  test('zero, a negative and a fraction are all refused at declaration', () => {
    expect(declare(0)).toThrow(/X_INVARIANT/);
    expect(declare(-1)).toThrow(/X_INVARIANT/);
    expect(declare(1.5)).toThrow(/X_INVARIANT/);
  });

  /**
   * The RESULT is returned, never discarded. `declare(0)();` as a bare expression statement does
   * not run at all under Bun 1.3.14 — the call is elided when its value is unused, so the `catch`
   * never fires and the assertion below reads `undefined` from an error that was never raised.
   * That is a test which cannot fail; `void declare(0)()` or using the value both run it.
   */
  const refusalFrom = (concurrency: number): { cause?: string; fix?: string } => {
    try {
      return { cause: `no refusal: ${declare(concurrency)().name}` };
    } catch (error) {
      return error as { cause?: string; fix?: string };
    }
  };

  test('the refusal names the job and the edit', () => {
    const refusal = refusalFrom(0);

    expect(refusal.cause).toContain('capped-0');
    expect(refusal.cause).toContain('no worker can ever fill');
    expect(refusal.fix).toContain('omit the field for no cap at all');
  });

  test('an omitted concurrency is still "no cap", not a refusal', () => {
    expect(notify.concurrency).toBeUndefined();
    expect(refusalFrom(1).cause).toContain('no refusal: capped-1');
  });
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
      tenant: 'none',
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
      tenant: 'none',
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
        input: PERMISSIVE,
        queue: 'maintenance',
        retry: { attempts: 5, backoff: 'linear' },
        steps: [],
      },
      {
        name: 'notifySubscribers',
        input: PERMISSIVE,
        queue: 'default',
        retry: { attempts: 3, backoff: 'exponential' },
        steps: [],
      },
    ]);
  });

  test('the order is CODE UNITS, not the runtime locale', () => {
    // `describeJobs()` is mapped straight into `x.manifest.json`, which both tracked apps commit
    // and `x verify`'s drift step diffs byte for byte. `localeCompare` with no locale argument
    // answers from the runtime's ICU default and collation version, so the same source built on
    // two machines could emit two orders — `'a'.localeCompare('B')` is -1 and `'a' < 'B'` is
    // false. The rule is `@ultimat3/http`'s, already written down for `describeRoutes`.
    for (const name of ['aOrg', 'BOrg', '_internal']) {
      job<OrgInput>({
        tenant: 'none',
        name,
        input: passthrough<OrgInput>(),
        idempotencyKey: ({ orgId }) => `${name}:${orgId}`,
        retry: { attempts: 1 },
        run: () => Promise.resolve(),
      });
    }

    expect(registeredJobs().map((handle) => handle.name)).toEqual([
      'BOrg',
      '_internal',
      'aOrg',
      'notifySubscribers',
    ]);
  });

  test('handle.describe() and describeJobs() agree', () => {
    expect(describeJobs()).toEqual([notify.describe()]);
  });

  test('a real schema is published as JSON Schema, not as its vendor name', () => {
    resetJobs();
    const provision = job({
      tenant: 'none',
      name: 'provisionOrg',
      input: t.object({ orgId: t.string, seats: t.number }),
      idempotencyKey: ({ orgId }) => `provision:${orgId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    const { input } = provision.describe();
    expect(input['type']).toBe('object');
    expect(Object.keys((input['properties'] ?? {}) as Record<string, unknown>).sort()).toEqual([
      'orgId',
      'seats',
    ]);
  });

  test('backoff falls back to the default when the definition omits it', () => {
    resetJobs();
    const sweep = job<OrgInput>({
      tenant: 'none',
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
      tenant: 'none',
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
