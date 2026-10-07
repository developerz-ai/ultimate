// The UNIT tests `x g job` / `x g task` write beside the `.job.test.ts`: the body, run by an
// in-process worker (`runJobs`) against the in-memory queue and the in-memory driver. Split from
// `job.ts`, which owns the declarations and the job-suite tests — an app's coverage floor counts
// the unit suite alone, so a body only the `job` step runs is uncovered source.

import { sortedImports } from './imports';
import type { NameSet } from './naming';

const ID = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';

/** The steps one run of the tenant-scoped body may take, and which test proves each. */
export interface JobBodyShape {
  /** The body reads `../repo` under the org its input names. */
  readonly scoped: boolean;
  /** The slice still takes the row `x g entity` scaffolds, so a test may store one. */
  readonly storesRow: boolean;
  readonly dbModule: string;
}

const HEADER = (
  name: NameSet,
): string => `// ${name.camel}'s BODY, run by a worker in this process: \`runJobs\` enqueues, claims and executes
// against an in-memory queue, so what this pins is which steps one run takes and what the body
// answers. The durable guarantees — the idempotency key, the dedupe, the retry policy — are the
// job suite's, next door.`;

const storedRowTest = (name: NameSet): string => `
unitTest('a stored row is loaded, then processed, once each', async ({ runJobs }) => {
  const draft = { orgId, title: 'kept', price: { minor: 0, currency: 'USD' } };
  const row = await runWithContext(ctxOf({ actor: member }), () => repo.insert(draft));
  const trace = await runJobs(${name.camel}, { id: row.id, orgId });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toEqual({ skipped: false });
  expect(trace.steps.load?.executions).toBe(1);
  expect(trace.steps.process?.executions).toBe(1);
});
`;

const scopedBodyTest = (name: NameSet, shape: JobBodyShape): string => `${HEADER(name)}
${sortedImports([
  ...(shape.storesRow
    ? [
        "import { ctxOf, runWithContext } from '@ultimat3/core';",
        "import { testActor } from '@ultimat3/policy';",
        "import { afterEach, expect, unitTest } from '@ultimat3/testing';",
        `import { driver } from '${shape.dbModule}';`,
      ]
    : ["import { expect, unitTest } from '@ultimat3/testing';"]),
])}${shape.storesRow ? "\nimport * as repo from '../repo';" : ''}
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';
const orgId = '${ORG}';
${
  shape.storesRow
    ? `
// Who stores the row the job then reads: the body itself runs as the org its input names.
const member = testActor('member', { orgId }).actor;

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});
`
    : ''
}
unitTest('an id nothing holds stops after the load: nothing is processed', async ({ runJobs }) => {
  // The refusal branch first. \`completed\`, not failed: a row deleted between the enqueue and
  // the run is not an error to retry five times — and the body says which of the two it was.
  const trace = await runJobs(${name.camel}, { id, orgId });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toEqual({ skipped: true });
  expect(Object.keys(trace.steps)).toEqual(['load']);
});
${shape.storesRow ? storedRowTest(name) : ''}`;

const neutralBodyTest = (name: NameSet): string => `${HEADER(name)}
import { expect, unitTest } from '@ultimat3/testing';
import { ${name.camel} } from './${name.kebab}';

const id = '${ID}';

unitTest('one run takes its one step, once, and completes', async ({ runJobs }) => {
  const trace = await runJobs(${name.camel}, { id });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toEqual({ processed: true });
  expect(Object.keys(trace.steps)).toEqual(['process']);
  expect(trace.steps.process?.executions).toBe(1);
});
`;

/** `<name>.test.ts` for a job: its body, in the shape the slice earns. */
export const jobBodyTest = (name: NameSet, shape: JobBodyShape): string =>
  shape.scoped ? scopedBodyTest(name, shape) : neutralBodyTest(name);

/**
 * `<name>.test.ts` for a task: firing it, which is the one thing its `enqueue` function is for.
 * The payload it declares is run to completion by the same worker, so a payload the job's own
 * input schema refuses fails here rather than at 03:00.
 */
export const taskBodyTest = (
  name: NameSet,
  jobName: NameSet,
): string => `// ${name.camel}, fired: the job it queues and the payload it queues it with, run to completion by a
// worker in this process. The schedule — the cron and its time zone — is the job suite's, next door.
import { expect, unitTest } from '@ultimat3/testing';
import { ${jobName.camel} } from '../jobs/${jobName.kebab}';
import { ${name.camel} } from './${name.kebab}';

unitTest('firing it queues its one job, and that payload completes', async ({ runJobs }) => {
  const queued = await ${name.camel}.enqueue();
  const jobs = queued.map((result) => result.job);
  expect(jobs).toEqual([${jobName.camel}.name]);
  expect(await runJobs.depth(${jobName.camel})).toBe(1);
  // A payload the job's input schema refuses fails the run, here rather than on the schedule.
  const trace = await runJobs.drain();
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(await runJobs.depth(${jobName.camel})).toBe(0);
});
`;
