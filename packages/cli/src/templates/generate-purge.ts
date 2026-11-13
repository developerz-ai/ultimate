// `x g purge` — the retention sweep for every `retain` the schema declares, and the hourly task that
// fires it. `purge()` is a factory over `job()`, never a ninth primitive; without one covering a
// `retain`, `x verify` refuses it (`X_ENTITY_RETAIN_UNSWEPT`), so this is the declaration that answers.

import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';

const source = (
  name: NameSet,
): string => `// ${name.camel}: every \`retain\` the schema declares, kept. \`purge()\` is a factory over job(),
// so a sweep is retried, cancellable and in the manifest like any job. \`entities: 'declared'\`
// reads the declarations on every pass: a new \`retain\` on an entity needs no line here.
// List this module in apps/web/api/index.ts's \`jobs:\` to register it; ../tasks fires it hourly.

import { purge } from '@ultimat3/jobs';

export const ${name.camel} = purge({
  // Pinned: the queue keys the rows it already stores by this name.
  name: '${name.kebab}',
  entities: 'declared',
});
`;

const taskSource = (
  name: NameSet,
): string => `// ${name.camel}Hourly: fires ${name.camel} on the framework's purge cron, in an explicit zone. A task
// only enqueues; the sweep itself is the durable, retried job.

import { DEFAULT_PURGE_CRON, task } from '@ultimat3/jobs';
import { ${name.camel} } from '../jobs/${name.kebab}';

export const ${name.camel}Hourly = task({
  name: '${name.kebab}.hourly',
  cron: DEFAULT_PURGE_CRON,
  tz: 'UTC',
  enqueue: () => [[${name.camel}, {}]],
});
`;

const jobSuite = (
  name: NameSet,
): string => `// ${name.camel}'s durable identity — one live sweep per name — and the task that fires it.

import { DEFAULT_PURGE_CRON, memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { ${name.camel}Hourly } from '../tasks/${name.kebab}-hourly';
import { ${name.camel} } from './${name.kebab}';

// The queue is a process-global adapter port, so it is swapped for this file and put back after.
beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

jobTest('${name.camel} is a job its hourly task enqueues, in an explicit zone', () => {
  expect(${name.camel}.kind).toBe('job');
  expect(${name.camel}Hourly.cron).toBe(DEFAULT_PURGE_CRON);
  expect(${name.camel}Hourly.tz).toBe('UTC');
  expect(${name.camel}Hourly.entries().map(([handle]) => handle)).toEqual([${name.camel}]);
});

jobTest('${name.camel} enqueues once, and dedupes a second sweep while one is live', async () => {
  const first = await ${name.camel}.enqueue({});
  expect(first.deduped).toBe(false);
  const again = await ${name.camel}.enqueue({});
  expect(again.deduped).toBe(true);
});
`;

const unitSuite = (
  name: NameSet,
): string => `// ${name.camel}'s BODY, run by a worker in this process: one pass completes and reports what it
// removed — a number, never a guess, so \`x jobs show\` can print it.

import { expect, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

unitTest('one pass completes and reports how many rows it removed', async ({ runJobs }) => {
  const trace = await runJobs(${name.camel}, {});
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toMatchObject({ removed: 0 });
});
`;

/** The sweep and its job/unit tests in the feature's `jobs/`, the hourly task in its `tasks/`. */
export function purgeFiles(rawName: string, target: FeatureTarget): readonly GeneratedFile[] {
  const name = names(rawName);
  const dir = `${target.surfaceDir}/${target.feature}`;
  return [
    { path: `${dir}/jobs/${name.kebab}.ts`, contents: source(name) },
    { path: `${dir}/jobs/${name.kebab}.job.test.ts`, contents: jobSuite(name) },
    { path: `${dir}/jobs/${name.kebab}.test.ts`, contents: unitSuite(name) },
    { path: `${dir}/tasks/${name.kebab}-hourly.ts`, contents: taskSource(name) },
  ];
}
