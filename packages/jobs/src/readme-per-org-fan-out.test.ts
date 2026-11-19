// The README's per-org fan-out, RUN: the fence's own text is transpiled and executed on the memory
// driver, so the example an agent copies is the one proved — the cron job lists orgs across tenants
// without `X_TENANCY_CROSS_DENIED`, and every child is queued under, and runs as, its own org.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as core from '@ultimat3/core';
import * as entity from '@ultimat3/entity';
import { installJobDriver, resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import * as jobs from './index';
import { resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';
import { jobWorker } from './worker';

const HEADING = '### One job per org, from a schedule';
const MODULES: Readonly<Record<string, unknown>> = {
  '@ultimat3/core': core,
  '@ultimat3/entity': entity,
  '@ultimat3/jobs': jobs,
};

interface Sample {
  readonly orgDigest: jobs.AnyJobHandle;
  readonly orgDigests: jobs.AnyJobHandle & { readonly schedule: jobs.TaskHandle };
}

/** What the fence leaves to the app: the org list (a tenant-scoped read) and one org's work. */
interface Stubs {
  readonly listOrgIds: () => Promise<readonly string[]>;
  readonly sendDigest: (orgId: string) => Promise<void>;
}

/** The fence as written, its imports bound to this checkout's modules and its `declare`s to stubs. */
async function readmeSample(stubs: Stubs): Promise<Sample> {
  const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
  const fence = /```ts\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf(HEADING)))?.[1];
  if (fence === undefined || !readme.includes(HEADING)) {
    return expect.unreachable('the README has its per-org fan-out fence');
  }
  const body = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(fence)
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g,
      (_all, names: string, from: string) =>
        `const {${names.replaceAll(' as ', ': ')}} = modules[${JSON.stringify(from)}];`,
    )
    .replace(/export\s+(const|var|let)\s/g, '$1 ');
  expect(body).not.toContain('import ');
  const build = new Function(
    'modules',
    'listOrgIds',
    'sendDigest',
    `${body}\nreturn { orgDigest, orgDigests };`,
  ) as (modules: unknown, list: Stubs['listOrgIds'], send: Stubs['sendDigest']) => Sample;
  return build(MODULES, stubs.listOrgIds, stubs.sendDigest);
}

const ORG_A = '018f3b5e-0000-7000-8000-00000000000a';
const ORG_B = '018f3b5e-0000-7000-8000-00000000000b';
// 2026-07-26T06:00:00Z.
const OCCURRENCE = Date.UTC(2026, 6, 26, 6, 0, 0);

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe("the README's per-org fan-out from a schedule", () => {
  test('lists orgs across tenants, then queues and runs one job per org AS that org', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const listedBy: string[] = [];
    const sentAs: (readonly [string, string | undefined])[] = [];
    const { orgDigest, orgDigests } = await readmeSample({
      // The stand-in for a tenant-scoped read: it spans orgs only inside a PROVEN `crossTenant()`.
      listOrgIds: async () => {
        entity.crossTenant('the stub read re-proves the scope the README opened', () => undefined);
        listedBy.push(core.useContext().actor.id);
        return [ORG_A, ORG_B];
      },
      sendDigest: async (orgId) => {
        sentAs.push([orgId, core.useContext().actor.orgId]);
      },
    });

    expect(orgDigests.schedule.entries(OCCURRENCE)).toEqual([
      [orgDigests, { occurrenceMs: OCCURRENCE }],
    ]);
    await orgDigests.enqueue({ occurrenceMs: OCCURRENCE });

    const worker = jobWorker({
      driver,
      context: () => core.ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    try {
      // The fan-out, then the two children it queued.
      const fanOut = await worker.tick();
      expect(fanOut.map((run) => [run.job, run.outcome])).toEqual([['orgDigests', 'completed']]);
      const queued = (await driver.introspect?.list()) ?? [];
      expect(
        queued
          .filter((row) => row.name === orgDigest.name)
          .map((row) => row.tenantId)
          .sort(),
      ).toEqual([ORG_A, ORG_B]);
      const children = await worker.tick();
      expect(children.map((run) => run.outcome)).toEqual(['completed', 'completed']);
    } finally {
      await worker.stop('test-end');
    }

    expect(listedBy).toEqual(['digest-scheduler']);
    expect([...sentAs].sort()).toEqual([
      [ORG_A, ORG_A],
      [ORG_B, ORG_B],
    ]);
  });
});
