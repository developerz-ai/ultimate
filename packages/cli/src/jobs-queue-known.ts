// `x jobs pause|resume <queue>` names a queue this app serves. A typo paused nothing and reported
// success, and the runbook's next step (poll the queue until it is empty) then passed at once
// while the real queue kept claiming. The set is `x deploy verify`'s: config plus registered jobs.

import { nearestName, renderCauseValue, UltimateError } from '@ultimat3/core';
import { expectedQueues } from './deploy-verify-queues';
import { quoteArg } from './shell-quote';

/** The queue positional names nothing this app's workers claim from. */
export class JobsQueueUnknownError extends UltimateError {
  constructor(input: { sub: 'pause' | 'resume'; queue: string; known: readonly string[] }) {
    const nearest = nearestName(input.queue, input.known);
    super({
      code: 'X_CLI_BAD_FLAG',
      cause: `"x jobs ${input.sub}" was given queue ${renderCauseValue(input.queue)}, which is not a queue of this app (${input.known.map((queue) => renderCauseValue(queue)).join(', ')}) — no worker claims from it, so the ${input.sub} would change nothing`,
      fix:
        nearest === undefined
          ? 'x jobs list --json   # data.depth.queues names what each queue holds'
          : ['x', 'jobs', input.sub, quoteArg(nearest), '--json'].join(' '),
      meta: { queue: input.queue, known: [...input.known] },
    });
  }
}

/**
 * Refuses before the pause row is written. An app that will not load is "cannot tell" — its jobs'
 * queues are the half of the set a broken module hides — and is never refused on a guess. `resume`
 * of a queue that IS paused always passes: that row is what the command exists to clear.
 */
export async function assertQueueServed(
  root: string,
  sub: 'pause' | 'resume',
  queue: string,
  paused: readonly string[],
): Promise<void> {
  if (sub === 'resume' && paused.includes(queue)) return;
  const expected = await expectedQueues(root);
  // An app with no module at all hides nothing: its set is the configured queues, whole.
  if (expected.findings.some((finding) => finding.code !== 'X_APP_EMPTY')) return;
  // Nothing configured and nothing registered is the worker's own `default`.
  const known = expected.queues.length === 0 ? ['default'] : expected.queues;
  if (!known.includes(queue)) throw new JobsQueueUnknownError({ sub, queue, known });
}
