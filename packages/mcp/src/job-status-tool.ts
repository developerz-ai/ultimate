/**
 * `job_status` — the one read every `jobTool()` points at, projected once per server that declares
 * any. Gated per ROW, as `whoami` is gated per caller: the caller must be the actor that enqueued
 * it, in the same org. Anything else — another actor, another org, an id nobody issued, a job no
 * tool of this server runs — is the SAME not-found, because `uuidV7` ids are time-ordered guesses.
 */

import { asCallerContext, guardActionBeforeInput } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { actorOf, useContext } from '@ultimat3/core';
import { JobNotFoundError } from '@ultimat3/jobs';
import { can } from '@ultimat3/policy';
import type { ProjectablePrimitive } from './from-action';
import type { JobToolBrand } from './job-tool';
import { introspection, JOB_STATUS_TOOL, running, settled } from './job-tool';

export function jobStatusPrimitive(brands: readonly JobToolBrand[]): ProjectablePrimitive {
  const byJob = new Map(brands.map((brand) => [brand.job.name, brand]));
  const description =
    'Read a long-running job this caller started: running, done with its result, or failed with its code and, when the error declares one, its callerFix.';
  return {
    name: JOB_STATUS_TOOL,
    description,
    mcp: { expose: true, description, annotations: { readOnlyHint: true } },
    inputJsonSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The jobId a job tool answered.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    mutates: false,
    run: ({ input, actor }) =>
      asCallerContext(actor, async () => {
        const jobId = readJobId(input);
        const row = await introspection().job(jobId);
        const brand = row === undefined ? undefined : byJob.get(row.name);
        if (row === undefined || brand === undefined || !owns(row, actor)) {
          throw new JobNotFoundError({ jobId, driver: 'jobs' });
        }
        // The tool's own permission still decides: a caller who lost it reads nothing more.
        const ctx = useContext();
        guardActionBeforeInput(
          can(brand.policy),
          { actor: actorOf(ctx), ctx, action: JOB_STATUS_TOOL },
          'mcp',
        );
        return (await settled(row, brand.result, brand.resultInput)) ?? running(row.id);
      }),
  };
}

/** The validated args carry a string `jobId`; anything else is the same not-found. */
function readJobId(input: unknown): string {
  const jobId =
    typeof input === 'object' && input !== null ? (input as { jobId?: unknown }).jobId : undefined;
  return typeof jobId === 'string' ? jobId : '';
}

/** `enqueuedBy` is attribution for what a body may do; here it answers whose request this was. */
function owns(
  row: { readonly enqueuedBy?: string; readonly tenantId?: string },
  actor: Actor,
): boolean {
  if (row.enqueuedBy === undefined || row.enqueuedBy !== actor.id) return false;
  return row.tenantId === undefined || row.tenantId === (actor.orgId ?? undefined);
}
