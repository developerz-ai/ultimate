// The posts export's job, as its org sees it: the status read and the cancel `postsExportStatus`
// and `cancelPostsExport` are declared over. The tenant is the org the input names, which the
// policy has already held to the actor's own; the job name narrows the fence to exports only, so
// an export endpoint never answers for another job of the same org.

import type { JobDriver, JobStatus } from '@ultimat3/jobs';
import { cancelJobFor, JOB_STATES, jobDriver, jobStatusFor } from '@ultimat3/jobs';
import { PostsExportNotFound, PostsExportQueueUnavailable } from './errors';
import { exportPosts } from './jobs/export-posts';

/** Every state a job row can be in — what the cancel answers, as the action's output declares. */
export const EXPORT_JOB_STATES = JOB_STATES;

const queue = (what: string): JobDriver => {
  const driver = jobDriver();
  if (driver === undefined) throw new PostsExportQueueUnavailable(what);
  return driver;
};

/** The org's export job, or nothing: another org's id and an unknown one answer alike. */
export function exportJobStatus(orgId: string, jobId: string): Promise<JobStatus | undefined> {
  return jobStatusFor(queue('reading a posts export'), {
    jobId,
    tenantId: orgId,
    name: exportPosts.name,
  });
}

/**
 * Stop the org's export if it is still queued or running, and answer it as it now stands. An id
 * the org does not own is the 404 a missing one is — never a refusal that says it exists.
 */
export async function cancelExportJob(
  orgId: string,
  jobId: string,
  actorId: string,
): Promise<JobStatus> {
  const status = await cancelJobFor(queue('cancelling a posts export'), {
    jobId,
    tenantId: orgId,
    name: exportPosts.name,
    reason: `cancelled by ${actorId}`,
  });
  if (status === undefined) throw new PostsExportNotFound(jobId);
  return status;
}
