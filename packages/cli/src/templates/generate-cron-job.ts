// `x g cron-job` — a job and the task that fires it, from one `cronJob()` declaration: a factory
// over `job()` and `task()`, never a ninth primitive. The handle IS the job and `.schedule` its
// task, so the scheduler's last firing and the queue's rows follow the one pinned name.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const source = (
  name: NameSet,
): string => `// ${name.camel}: a job and the task that fires it, from one declaration. \`cronJob()\` is a factory
// over job() and task(), so \`${name.camel}.schedule\` is a task like any other, named
// \`${name.kebab}.schedule\`. List this module in apps/web/api/index.ts's \`jobs:\` to register it.

import { cronJob } from '@ultimat3/jobs';

export const ${name.camel} = cronJob({
  // Pinned: the scheduler keys \`.schedule\`'s last firing by this name, the queue its rows.
  name: '${name.kebab}',
  cron: '0 3 * * *',
  // REQUIRED IANA zone: "server time" is not a timezone, and an unzoned cron drifts at every DST
  // switch. Per-member local times are a fan-out from here, one enqueue per zone.
  tz: 'UTC',
  // A schedule has no request behind it, so there is no org to inherit. \`'none'\` STRIPS the org,
  // so a tenant-scoped read added below fails closed (X_TENANCY_ACTOR_ORG_REQUIRED) instead of
  // reading whichever org a worker last held.
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ step, ctx }) {
    // One durable step per unit of work: a retry replays the finished ones from storage, so put
    // each write in its own \`step.run\` under a stable name.
    const ranAt = await step.run('run', () => ctx.now().toISOString());
    return { ranAt };
  },
});
`;

const jobSuite = (
  name: NameSet,
): string => `// ${name.camel}'s durable identity: a job, its schedule in an explicit zone, and one live run per
// name. The body is the unit suite's, next door.

import { memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

// The queue is a process-global adapter port, so it is swapped for this file and put back after.
beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

jobTest('${name.camel} is a job, fired by its own schedule in an explicit zone', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.schedule.kind).toBe('task');
  expect(${name.camel}.schedule.name).toBe('${name.kebab}.schedule');
  expect(${name.camel}.schedule.tz).toBe('UTC');
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('${name.camel} enqueues once, and dedupes a second run while one is live', async () => {
  const first = await ${name.camel}.enqueue({});
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue({});
  expect(again.deduped).toBe(true);
});
`;

const unitSuite = (
  name: NameSet,
): string => `// ${name.camel}'s BODY, run by a worker in this process against the in-memory queue: one
// occurrence completes, and its one step runs once.

import { expect, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

unitTest('one occurrence runs its step once and completes', async ({ runJobs }) => {
  const trace = await runJobs(${name.camel}, {});
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.steps.run?.executions).toBe(1);
});
`;

/** The job with its schedule, its job-suite test and its unit test, in the feature's `jobs/`. */
export function cronJobFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const dir = `${target.surfaceDir}/${target.feature}/jobs`;
  return [
    { path: `${dir}/${name.kebab}.ts`, contents: source(name) },
    { path: `${dir}/${name.kebab}.job.test.ts`, contents: jobSuite(name) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: unitSuite(name) },
  ];
}
