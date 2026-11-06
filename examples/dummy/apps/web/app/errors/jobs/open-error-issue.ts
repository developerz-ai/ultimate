/**
 * What Postly does the FIRST time an error group appears: `errorGroupsSink`'s `onNewGroup`, enqueued
 * exactly once per fingerprint across every replica (`x_error_groups`' upsert decides "new"). Which
 * tracker, which title, which assignee are an app's own business, never the framework's — Postly
 * has no tracker, so the issue it opens is one structured log line an operator's alerting reads.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { logger } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';

export const openErrorIssue = job({
  // The sink's `ErrorGroupNotice`, field for field: what grouped the report, nothing it carried.
  input: t.object({
    fingerprint: t.string,
    code: t.string,
    source: t.string,
    operation: t.nullable(t.string),
    message: t.string,
    firstSeen: t.string,
  }),
  // One issue per group, even when the sink's enqueue is retried after a lost answer.
  idempotencyKey: ({ fingerprint }) => `error-issue:${fingerprint}`,
  // A group is the fleet's, not an org's: the payload names no tenant and the body reads no table.
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, step }) {
    await step.run('issue', () => {
      logger.warn('postly new error group', {
        fingerprint: input.fingerprint,
        code: input.code,
        source: input.source,
        operation: input.operation,
        message: input.message,
        firstSeen: input.firstSeen,
      });
    });
  },
});
