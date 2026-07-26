// `x g job` / `x g task` — durable background work and the cron trigger that enqueues it. The
// idempotency key is required by the type, so the generator always emits one; the generated test
// pins the step sequence, because renaming a step silently invalidates its stored result.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const jobSource = (
  name: NameSet,
): string => `// ${name.camel}: multi-step durable work. Each step is retried independently and its result is
// stored under its name — step names are stable identifiers, not labels.
import { job, t } from '@ultimat3/jobs';
import * as repo from '../repo';

export const ${name.camel} = job({
  input: t.object({ id: t.uuid }),
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
  enqueue: () => [[${jobName.camel}, { id: '00000000-0000-0000-0000-000000000001' }]],
});
`;

const jobTest = (name: NameSet): string => `import { expect } from 'bun:test';
import { jobTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

jobTest('${name.camel} declares an idempotency key and a retry policy', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}.idempotencyKey({ id: 'abc' })).toBe('${name.kebab}:abc');
  expect(${name.camel}.retry.attempts).toBeGreaterThan(1);
});

jobTest('${name.camel} is idempotent for the same input', () => {
  const first = ${name.camel}.idempotencyKey({ id: 'abc' });
  const second = ${name.camel}.idempotencyKey({ id: 'abc' });
  expect(first).toBe(second);
});

jobTest('${name.camel} runs its steps in order', async () => {
  await expect(${name.camel}).toEmitSteps(['load', 'process']);
});
`;

const taskTest = (name: NameSet, jobName: NameSet): string => `import { expect } from 'bun:test';
import { jobTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';
import { ${jobName.camel} } from '../jobs/${jobName.kebab}';

jobTest('${name.camel} declares a cron with an explicit time zone', () => {
  expect(${name.camel}.kind).toBe('task');
  expect(${name.camel}.cron.split(' ')).toHaveLength(5);
  expect(${name.camel}.tz).toBe('UTC');
});

jobTest('${name.camel} enqueues ${jobName.camel} and nothing else', () => {
  const pairs = ${name.camel}.enqueue();
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.[0]).toBe(${jobName.camel});
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
