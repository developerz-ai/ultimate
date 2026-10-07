// The jobs suites' one harness: a memory queue with ONE job in every state, a worker in the
// registry, a scheduled task, and an admin that declares nothing but itself — the dashboard is
// what every `defineAdmin()` carries. A request is answered and rendered as a host would.

import { expect } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import {
  type JobDriver,
  type JobIntrospection,
  type JobState,
  job,
  type MemoryJobDriver,
  memoryJobDriver,
  setJobDriver,
  t,
  task,
} from '@ultimat3/jobs';
import type { AdminApp } from '../admin';
import type { AdminActor } from '../authz';
import { staticAuthz } from '../authz';
import type { AdminRouteResponse } from '../screen-frame';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('../admin');
const { adminRouteMatch } = await import('../routes');

/** Reads every jobs screen. No `job:manage`, so no control. */
export const READER = ['admin:read', 'job:read'] as const;
/** Reads and changes: `admin:write`/`admin:destroy` in front of `job:manage`, as every action asks. */
export const MANAGER = [...READER, 'admin:write', 'admin:destroy', 'job:manage'] as const;

let minted = 0;

/** A uniquely named job: the registry is process-wide and the suites share one process. */
export function fixtureJob(run: () => Promise<unknown> = () => Promise.resolve()) {
  minted += 1;
  return job<{ readonly item: string }>({
    name: `admin-jobs-fixture-${minted}`,
    tenant: 'none',
    input: t.object({ item: t.string }),
    idempotencyKey: ({ item }) => item,
    retry: { attempts: 1, jitter: false },
    run,
  });
}

export interface Seeded {
  readonly driver: MemoryJobDriver;
  readonly operator: JobIntrospection;
  readonly ids: Readonly<Record<JobState, string>>;
  readonly name: string;
  readonly task: string;
}

const enqueue = (
  driver: JobDriver,
  name: string,
  item: string,
  extra: { readonly runAt?: number; readonly tenantId?: string; readonly queue?: string } = {},
) =>
  driver.enqueue({
    name,
    queue: extra.queue ?? 'default',
    input: { item, password: 'CANARY-SECRET' },
    idempotencyKey: item,
    maxAttempts: 1,
    ...(extra.runAt === undefined ? {} : { runAt: extra.runAt }),
    ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }),
  });

/** Claim exactly `id`: everything else this pass claimed is handed back untouched. */
async function claimOne(driver: JobDriver, id: string, workerId: string): Promise<number> {
  const claimed = await driver.claim({
    queues: ['default'],
    limit: 50,
    visibilityTimeoutMs: 60_000,
    workerId,
  });
  let mine = 0;
  for (const row of claimed) {
    if (row.id === id) mine = row.claim;
    else
      await driver.nack(row.id, { workerId, claim: row.claim, delayMs: 0, countsAsAttempt: false });
  }
  if (mine === 0) return expect.unreachable(`job ${id} was not claimable`);
  return mine;
}

/** One job in every state the queue has, each tenant `org-a` except the `ready` one. */
export async function seedQueue(): Promise<Seeded> {
  const driver = memoryJobDriver();
  setJobDriver(driver);
  const operator = driver.introspect;
  if (operator === undefined) return expect.unreachable('the memory driver ships introspection');
  const handle = fixtureJob();
  const scheduled = task({
    name: `admin-jobs-fixture-task-${minted}`,
    cron: '0 9 * * *',
    tz: 'America/Bogota',
    enqueue: (occurrenceMs) => [[handle, { item: `from-task-${occurrenceMs}` }]],
  });
  const name = handle.name;
  const tenant = { tenantId: 'org-a' };
  const at = Date.now();
  const id = async (item: string, extra = {}) =>
    (await enqueue(driver, name, item, { ...tenant, ...extra })).id;

  const ready = (await enqueue(driver, name, 'ready', { tenantId: 'org-b' })).id;
  const delayed = await id('delayed', { runAt: at + 3_600_000 });
  const running = await id('running');
  const suspended = await id('suspended');
  const done = await id('done');
  const failed = await id('failed');
  const dead = await id('dead');
  const cancelled = await id('cancelled');

  await claimOne(driver, running, 'worker-1');
  const parked = await claimOne(driver, suspended, 'worker-1');
  await driver.nack(suspended, {
    workerId: 'worker-1',
    claim: parked,
    delayMs: 60_000,
    countsAsAttempt: false,
    park: true,
  });
  const acked = await claimOne(driver, done, 'worker-1');
  await driver.ack(done, { workerId: 'worker-1', claim: acked, durationMs: 40 });
  const dropped = await claimOne(driver, failed, 'worker-1');
  await driver.nack(failed, {
    workerId: 'worker-1',
    claim: dropped,
    delayMs: 0,
    fail: true,
    error: 'gave up',
  });
  const lettered = await claimOne(driver, dead, 'worker-1');
  await driver.nack(dead, {
    workerId: 'worker-1',
    claim: lettered,
    delayMs: 0,
    deadLetter: true,
    error: 'X_BOOM: the upstream refused',
  });
  await operator.cancel?.(cancelled, 'operator');

  await operator.announceWorker(
    {
      id: 'worker-1',
      host: 'pod-a',
      startedAt: at - 60_000,
      queues: ['default'],
      concurrency: 4,
      inFlight: [running],
    },
    60_000,
  );
  return {
    driver,
    operator,
    name,
    task: scheduled.name,
    ids: { ready, delayed, running, suspended, done, failed, dead, cancelled },
  };
}

/** An admin of nothing but the dashboard every admin carries. Its authz is a grant list. */
export function jobsAdmin(basePath: string, granted: readonly string[] = MANAGER): AdminApp {
  return defineAdmin({ basePath, entities: [], auth: { authz: staticAuthz(granted) } });
}

export interface Answer {
  readonly response: AdminRouteResponse;
  readonly html: string;
  readonly status: number | string;
}

/** One request to one admin route, as `actor`: matched, answered, rendered. */
export function ask(
  app: AdminApp,
  actor: AdminActor,
  path: string,
  form?: Readonly<Record<string, unknown>>,
): Promise<Answer> {
  return runWithContext(ctxOf({ tz: 'UTC', locale: 'en' }), async () => {
    const url = `http://localhost${path}`;
    const matched = adminRouteMatch(app, new URL(url).pathname);
    if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
    const response = await matched.route.respond({
      ctx: app.ctx({ actor, requestId: `req-${path}` }),
      params: matched.params,
      url,
      method: form === undefined ? 'GET' : 'POST',
      form: form ?? null,
    });
    const html =
      response.kind === 'document'
        ? await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
        : '';
    const status = response.kind === 'document' ? response.status : response.location;
    return { response, html, status };
  });
}
