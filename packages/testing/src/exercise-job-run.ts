// A job primitive's one execution, as the exercise pass runs it: ALONE, on a queue that holds nothing
// else, for one worker pass. What it enqueues is handed back to the caller's queue unrun, exactly as
// an action's enqueues are — counted there as `enqueue` effects, searched by the tenant proof, and
// never executed inside the subject's room, so a child's statements are never the subject's.

import type { Actor } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { AnyJobHandle, JobExecution, JobRecord } from '@ultimat3/jobs';
import { jobCursor, jobDriver, MAX_JOB_PAGE, registeredJobs } from '@ultimat3/jobs';
import type { RunJobs } from './fixture-jobs';
import { testJobs } from './fixture-jobs';

const QUEUED: ReadonlySet<string> = new Set(['ready', 'delayed']);

/** Every row the AMBIENT driver holds, page by page: what a fixture's queue has, finished or not. */
export async function ambientJobRows(): Promise<readonly JobRecord[]> {
  const introspect = jobDriver()?.introspect;
  if (introspect === undefined) return [];
  const records: JobRecord[] = [];
  for (let after: string | undefined; ; ) {
    const page = await introspect.list({
      limit: MAX_JOB_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    records.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || page.length < MAX_JOB_PAGE) break;
    after = jobCursor(last);
  }
  return records;
}

/**
 * `handle` run once with `input` in `tenant`, as `actor`'s worker: enqueued on a fresh queue and
 * claimed by ONE pass, so the only run is its own — never a job `into` already held (an earlier
 * call's, an earlier primitive's) and never one it queued. Those it queued land on `into`, unrun.
 */
export async function runJobAlone(
  handle: AnyJobHandle,
  input: unknown,
  at: { readonly actor: Actor | null; readonly tenant: string },
  into: RunJobs,
): Promise<JobExecution | undefined> {
  let own: JobExecution | undefined;
  let queued: readonly JobRecord[];
  {
    await using alone = await testJobs();
    const row = await alone.enqueue(handle, input, { tenantId: at.tenant });
    const trace = await alone.tick(at.actor === null ? {} : { actor: at.actor });
    own = trace.executions.find((run) => run.jobId === row.id);
    queued = (await ambientJobRows()).filter(
      (record) => record.id !== row.id && QUEUED.has(record.state),
    );
  }
  const handles = new Map(registeredJobs().map((one) => [one.name, one]));
  for (const record of queued) {
    const child = handles.get(record.name);
    assert(
      child !== undefined,
      `job "${handle.name}" queued job "${record.name}" but nothing registered it`,
      `import the module that declares job("${record.name}") from the app's api module — the registry is populated by the import, not by the queue`,
    );
    await into.enqueue(child, record.input, {
      ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
    });
  }
  return own;
}
