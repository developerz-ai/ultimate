// `x g job` / `x g task` — durable background work and the cron trigger that enqueues it. The
// idempotency key and the tenant are both required by the type, so the generator always emits
// both; the generated test pins them through a real driver, because a key that is not stable is a
// job that runs twice and a tenant that is not declared is a job that reads the wrong org's rows.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const jobSource = (
  name: NameSet,
): string => `// ${name.camel}: multi-step durable work. Each step is retried independently and its result is
// stored under its name — step names are stable identifiers, not labels.
// \`t\` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { job, t } from '@ultimat3/jobs';
import * as repo from '../repo';

export const ${name.camel} = job({
  input: t.object({ id: t.uuid, orgId: t.uuid }),
  // The org this run's body acts as, derived from the job's OWN input — never from whoever
  // enqueued it, who may have changed orgs by the time a retried job settles. \`orgId\` is in the
  // input for this and no other reason: \`x g entity\` scaffolds \`tenant: 'orgId'\`, so every read
  // below is tenant-scoped. \`tenant: 'none'\` is the other spelling and it STRIPS the org, which
  // makes a tenant-scoped read fail closed with X_TENANCY_ACTOR_ORG_REQUIRED — use it only for a
  // job that touches no tenanted table.
  tenant: (input) => input.orgId,
  idempotencyKey: ({ id }) => \`${name.kebab}:\${id}\`,
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step }) {
    const row = await step.run('load', () => repo.byId(input.id));
    if (row === undefined) return { skipped: true };
    await step.run('process', async () => {
      await repo.listByOrg(row.orgId, 1);
    });
    return { skipped: false };
  },
});
`;

const taskSource = (
  name: NameSet,
  jobName: NameSet,
): string => `// ${name.camel}: a scheduled trigger. Tasks only enqueue jobs — the work itself is durable and
// retryable, and the schedule carries an explicit IANA time zone.

import { task } from '@ultimat3/jobs';
import { ${jobName.camel} } from '../jobs/${jobName.kebab}';

export const ${name.camel} = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  // The org rides in the payload because the job DECLARES its tenant from its own input: a task
  // has no request behind it, so there is no caller whose org could be read instead.
  enqueue: () => [
    [
      ${jobName.camel},
      {
        id: '00000000-0000-4000-8000-000000000001',
        orgId: '00000000-0000-4000-8000-000000000002',
      },
    ],
  ],
});
`;

const jobTest = (
  name: NameSet,
): string => `import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

const id = '00000000-0000-4000-8000-000000000001';
const orgId = '00000000-0000-4000-8000-000000000002';
const input = { id, orgId };

// The driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test happens to run next.
beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

jobTest('${name.camel} declares an idempotency key and a retry policy', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.idempotencyKeyFor(input)).toBe(\`${name.kebab}:\${id}\`);
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('${name.camel} derives the same key for the same input', () => {
  expect(${name.camel}.idempotencyKeyFor(input)).toBe(${name.camel}.idempotencyKeyFor(input));
});

jobTest('${name.camel} runs as the org its own input names', () => {
  // Not a formality: \`tenant: 'none'\` compiles just as well and strips the org, and every read in
  // this job is tenant-scoped — so this declaration is the whole of what stands between the body
  // and X_TENANCY_ACTOR_ORG_REQUIRED, or worse, another org's rows.
  expect(${name.camel}.tenantFor(input)).toBe(orgId);
});

jobTest('${name.camel} projects itself into the manifest', () => {
  const described = ${name.camel}.describe();
  expect(described.queue).toBe('default');
  expect(described.retry.attempts).toBe(5);
});

jobTest('${name.camel} enqueues once, and dedupes the retry', async () => {
  // The whole point of the key: an at-least-once caller may enqueue twice and the work still
  // happens once. \`.enqueue()\` is the one queue path — a job is never run inline.
  const first = await ${name.camel}.enqueue(input);
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue(input);
  expect(again.deduped).toBe(true);
});
`;

const taskTest = (
  name: NameSet,
  jobName: NameSet,
): string => `import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { ${jobName.camel} } from '../jobs/${jobName.kebab}';
import { ${name.camel} } from './${name.kebab}';

beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

jobTest('${name.camel} declares a cron with an explicit time zone', () => {
  expect(${name.camel}.kind).toBe('task');
  expect(${name.camel}.cron.split(' ')).toHaveLength(5);
  expect(${name.camel}.tz).toBe('UTC');
});

jobTest('${name.camel} enqueues ${jobName.camel} and nothing else', () => {
  const pairs = ${name.camel}.entries();
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.[0]).toBe(${jobName.camel});
});

jobTest('${name.camel} describes its schedule and its jobs', () => {
  const described = ${name.camel}.describe();
  expect(described.tz).toBe('UTC');
  expect(described.jobs).toHaveLength(1);
});

jobTest('${name.camel} fires its entries onto the same queue the scheduler would', async () => {
  // \`.enqueue()\` is the backfill path: the declared entries, through the facade a job handle
  // uses, with no scheduler and no leader involved.
  const results = await ${name.camel}.enqueue();
  expect(results).toHaveLength(1);
  expect(results[0]?.job).toBe(${jobName.camel}.name);
});
`;

export function jobFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const dir = `${target.surfaceDir}/${target.feature}/jobs`;
  return [
    { path: `${dir}/${name.kebab}.ts`, contents: jobSource(name) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: jobTest(name) },
  ];
}

export function taskFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const jobName = names(`${rawName}-job`);
  const dir = `${target.surfaceDir}/${target.feature}/tasks`;
  return [
    { path: `${dir}/${name.kebab}.ts`, contents: taskSource(name, jobName) },
    { path: `${dir}/${name.kebab}.test.ts`, contents: taskTest(name, jobName) },
    ...jobFiles(`${rawName}-job`, target),
  ];
}
