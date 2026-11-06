// Which consumer's run this async context is inside, and the refusal of that consumer enqueuing
// itself. A self-enqueue dedupes onto the running row and arms nothing (`recipes.job.test.ts`
// pins the trap), so it is made unreachable here rather than documented.

import { asyncContext } from '@ultimat3/core';
import { ConsumerSelfEnqueueError } from './consumer-errors';

/** Core's one async-context seam: server-only, like every job body. */
const running = asyncContext<string>('a consumer() run');

/** Run `fn` as consumer `name`'s body: every enqueue of `name` inside it is refused. */
export function asConsumer<T>(name: string, fn: () => T): T {
  return running.run(name, fn);
}

/** Throws `X_CONSUMER_SELF_ENQUEUE` when the caller is consumer `name`'s own run. */
export function refuseSelfEnqueue(name: string): void {
  if (running.get() === name) throw new ConsumerSelfEnqueueError({ consumer: name });
}
