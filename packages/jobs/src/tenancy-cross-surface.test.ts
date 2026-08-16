// One entity write, two surfaces, one verdict. No test in this repo compared two surfaces against
// each other, which is exactly why an explicit `ctx` honoured as a parameter but never installed as
// the ambient context shipped: `@ultimat3/entity`'s tenant guard derives from `tryUseContext()`, so
// the job surface ACCEPTED the write HTTP refused as `X_TENANCY_ACTOR_MISMATCH`.
//
// The assertions are written as an equality between the two surfaces, never as two independent
// expectations: a regression that reopens the hole on one of them has to fail here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Actor,
  type Ctx,
  createContext,
  defineService,
  isUltimateError,
  resetServices,
  runWithContext,
  userActor,
} from '@ultimat3/core';
import { clearRegistry, entity, memoryRepo, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { backfill } from './backfill';
import type { ClaimedJob, JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';

const posts = entity('cross_surface_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 40 }),
  },
});

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const ORG_A = idAt('a1');
const ORG_B = idAt('a2');

interface WriteInput {
  /** The org the RUN acts under — what `tenant` derives, and what HTTP takes from its session. */
  readonly actingOrgId: string;
  /** The org the ROW names. Naming another one is the mistake both surfaces must refuse. */
  readonly rowOrgId: string;
}

const writeInput = t.object({ actingOrgId: t.string, rowOrgId: t.string });

let repo: ReturnType<typeof memoryRepo<typeof posts.$row>>;

const actorFor = (orgId: string): Actor => userActor({ id: idAt('90'), orgId });

/**
 * A service that captures the org of the actor it was BUILT for — the one thing a spread of the
 * worker's context carries and a rebuild does not. Registered at module scope, the way an app's
 * `defineService` call registers at import, and handed back in `afterAll`.
 */
const PROBE = 'crossSurfaceTenantProbe';
defineService(PROBE, (ctx) => ({ orgId: ctx.actor.orgId }));

/** Narrowed, never cast: `ServiceBag` is `unknown` per key by design. */
const probeOrgOf = (service: unknown): string | undefined => {
  if (typeof service !== 'object' || service === null || !('orgId' in service)) return undefined;
  const orgId: unknown = (service as { orgId: unknown }).orgId;
  return typeof orgId === 'string' ? orgId : undefined;
};

/** The verdict of one attempt: a code, or `'ACCEPTED'`. Same vocabulary on both surfaces. */
const codeOf = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt();
    return 'ACCEPTED';
  } catch (error) {
    return isUltimateError(error) ? error.code : `threw ${String(error)}`;
  }
};

const write = (rowOrgId: string): Promise<unknown> =>
  repo.insert({ id: idAt('11'), orgId: rowOrgId, title: 'row' });

/** The HTTP surface, structurally: a handler running inside `runWithContext`. */
const overHttp = (actingOrgId: string, rowOrgId: string): Promise<string> =>
  runWithContext(createContext({ actor: actorFor(actingOrgId) }), () =>
    codeOf(() => write(rowOrgId)),
  );

/**
 * The job surface, structurally: the worker's own `executeJob`, with the worker's own context.
 *
 * `worker` is a parameter and not a constant because a worker context with NO org cannot tell
 * "the declaration stripped it" from "the declaration was ignored" — both end in
 * `X_TENANCY_ACTOR_ORG_REQUIRED`. A case that means to prove the stripping passes one WITH an org.
 */
const overJob = async (handle: AnyJobHandle, input: unknown, worker?: Ctx): Promise<string> => {
  const driver: JobDriver = createMemoryDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input,
    idempotencyKey: `k:${handle.name}`,
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  if (claimed === undefined) throw new Error('the driver claimed nothing');
  const execution = await executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle,
    // What `packages/cli/src/dev-roles.ts` builds for the worker role: a context with no actor.
    ctx: worker ?? createContext({ role: 'worker' }),
  });
  if (execution.outcome === 'completed') return 'ACCEPTED';
  return execution.error ?? execution.outcome;
};

beforeEach(() => {
  resetJobs();
  repo = memoryRepo(posts, []);
});

afterAll(() => {
  resetJobs();
  clearRegistry();
  // The service registry is process-global, so the probe above is handed back rather than left
  // installed on every `createContext` for the rest of the run.
  resetServices();
});

describe('one write, two surfaces, one verdict', () => {
  test('a row naming another org is refused identically over HTTP and over the job surface', async () => {
    const writeRow = job<WriteInput>({
      name: 'cross-surface-write',
      input: writeInput,
      idempotencyKey: (input) => `w:${input.rowOrgId}`,
      tenant: (input) => input.actingOrgId,
      retry: { attempts: 1 },
      run: async ({ input }) => {
        await write(input.rowOrgId);
      },
    });

    const http = await overHttp(ORG_A, ORG_B);
    const queued = await overJob(writeRow, { actingOrgId: ORG_A, rowOrgId: ORG_B });

    expect(http).toBe('X_TENANCY_ACTOR_MISMATCH');
    // The equality is the assertion. `ACCEPTED` here is the shipped defect.
    expect(queued).toContain(http);
    // And nothing landed: the row a job wrote is a row another tenant can read.
    const seen = await runWithContext(createContext({ actor: actorFor(ORG_B) }), () =>
      repo.findMany({}),
    );
    expect(seen.rows).toHaveLength(0);
  });

  test('the row a job may write is its own declared tenant, and that one lands', async () => {
    const writeRow = job<WriteInput>({
      name: 'cross-surface-allowed',
      input: writeInput,
      idempotencyKey: (input) => `w:${input.rowOrgId}`,
      tenant: (input) => input.actingOrgId,
      retry: { attempts: 1 },
      run: async ({ input }) => {
        await write(input.rowOrgId);
      },
    });

    expect(await overJob(writeRow, { actingOrgId: ORG_A, rowOrgId: ORG_A })).toBe('ACCEPTED');
    const seen = await runWithContext(createContext({ actor: actorFor(ORG_A) }), () =>
      repo.findMany({}),
    );
    expect(seen.rows).toHaveLength(1);
  });

  test("tenant: 'none' fails a tenant-scoped read CLOSED — it never inherits the worker's org", async () => {
    const sweep = job<Record<string, never>>({
      name: 'cross-surface-none',
      input: t.object({}),
      idempotencyKey: () => 'sweep',
      tenant: 'none',
      retry: { attempts: 1 },
      run: async () => {
        await repo.findMany({});
      },
    });

    // The worker is scoped to ORG_A, which is the only way this can fail for the right reason: a
    // run that INHERITED the worker's org would read ORG_A's rows and answer `ACCEPTED`, and
    // against the default org-less worker context both answers are the same refusal.
    const worker = createContext({ role: 'worker', actor: actorFor(ORG_A) });
    expect(await overJob(sweep, {}, worker)).toContain('X_TENANCY_ACTOR_ORG_REQUIRED');
  });

  test('a registered service is rebuilt for the DECLARED tenant, not the worker it was claimed by', async () => {
    let captured: string | undefined = 'never ran';
    const readService = job<WriteInput>({
      name: 'cross-surface-service',
      input: writeInput,
      idempotencyKey: () => 'service',
      tenant: (input) => input.actingOrgId,
      retry: { attempts: 1 },
      run: ({ ctx }) => {
        // `defineService` CLOSES OVER the ctx it was built for, so a run context spread off the
        // worker's would hand the body an instance answering the worker's org while every ambient
        // repository call answered the job's — one run acting as two tenants.
        captured = probeOrgOf(ctx.services[PROBE]);
        return Promise.resolve();
      },
    });

    const worker = createContext({ role: 'worker', actor: actorFor(ORG_B) });
    await overJob(readService, { actingOrgId: ORG_A, rowOrgId: ORG_A }, worker);

    expect(captured).toBe(ORG_A);
  });

  test('the run body sees its declared tenant as the AMBIENT actor, not only as a parameter', async () => {
    let ambient: string | undefined = 'unset';
    let handed: string | undefined = 'unset';
    const readActor = job<WriteInput>({
      name: 'cross-surface-actor',
      input: writeInput,
      idempotencyKey: () => 'actor',
      tenant: (input) => input.actingOrgId,
      retry: { attempts: 1 },
      run: async ({ ctx }) => {
        // The import is deliberately the ambient read the entity guard makes, not `ctx`.
        const { tryUseContext } = await import('@ultimat3/core');
        ambient = tryUseContext()?.actor.orgId;
        handed = ctx.actor.orgId;
      },
    });

    await overJob(readActor, { actingOrgId: ORG_A, rowOrgId: ORG_A });
    expect(ambient).toBe(ORG_A);
    expect(handed).toBe(ambient);
  });
});

describe('backfill() inherits tenant like every other job field', () => {
  test("a declared tenant reaches the handle the factory returns, and 'none' answers undefined", () => {
    const scoped = backfill<typeof posts.$row>({
      name: 'cross-surface-backfill-scoped',
      tenant: () => ORG_A,
      source: () => {
        throw new Error('never read');
      },
      handle: () => undefined,
    });
    const unscoped = backfill<typeof posts.$row>({
      name: 'cross-surface-backfill-none',
      tenant: 'none',
      source: () => {
        throw new Error('never read');
      },
      handle: () => undefined,
    });

    expect(scoped.tenantFor({})).toBe(ORG_A);
    expect(unscoped.tenantFor({})).toBeUndefined();
  });
});

describe('the declaration is required, at both ends', () => {
  test('a job built without one is X_JOB_TENANT_REQUIRED, naming both spellings', () => {
    const declare = (): unknown =>
      // The TYPE already refuses this; the cast is what a JS caller or generated code does.
      job({
        name: 'cross-surface-undeclared',
        input: t.object({}),
        idempotencyKey: () => 'k',
        retry: { attempts: 1 },
        run: async () => undefined,
      } as unknown as Parameters<typeof job>[0]);

    expect(declare).toThrow(/X_JOB_TENANT_REQUIRED|declares no tenant/);
    try {
      declare();
    } catch (error) {
      expect(isUltimateError(error) ? error.fix : '').toContain("tenant: 'none'");
      expect(isUltimateError(error) ? error.fix : '').toContain('tenant: (input) => input.orgId');
    }
  });

  test('a tenant() that answers an empty string is refused rather than carried', () => {
    const blank = job<WriteInput>({
      name: 'cross-surface-blank',
      input: writeInput,
      idempotencyKey: () => 'k',
      tenant: () => '',
      retry: { attempts: 1 },
      run: async () => undefined,
    });
    expect(() => blank.tenantFor({ actingOrgId: ORG_A, rowOrgId: ORG_A })).toThrow(/empty tenant/);
  });
});
