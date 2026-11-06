// The two `X_CONSUMER_*` codes and the classes that throw them. The registry is `error-codes.ts`;
// this file holds only the refusals, beside the factory (`consumer.ts`) that raises the first and
// the enqueue guard (`consumer-guard.ts`) that raises the second.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';

/**
 * A `consumer()` that could not be assembled correctly. Every one of these is a field whose
 * absence has no other build error: a consumer with no cursor re-reads its stream from the top on
 * every restart, and one with a `timeout` is killed mid-stream on a schedule nobody chose.
 */
export class ConsumerInvalidError extends UltimateError {
  constructor(input: {
    readonly consumer: string;
    readonly problem: string;
    readonly fix: string;
  }) {
    super({
      code: 'X_CONSUMER_INVALID',
      cause: `consumer "${input.consumer}" ${input.problem}`,
      fix: input.fix,
      meta: { consumer: input.consumer },
    });
  }
}

/**
 * A consumer's own body enqueued the consumer. That enqueue is deduped onto the row that is
 * running it, so it arms nothing — the trap `recipes.job.test.ts` pins. Refused instead of
 * answered: the supervisor task already re-arms every key.
 */
export class ConsumerSelfEnqueueError extends UltimateError {
  constructor(input: { readonly consumer: string }) {
    const name = renderFixShellArg(input.consumer, "'<consumer>'");
    super({
      code: 'X_CONSUMER_SELF_ENQUEUE',
      cause: `consumer "${input.consumer}" enqueued itself from inside its own run; that enqueue dedupes onto the running row and arms nothing, and the consumer's .supervisor task already re-arms every key`,
      fix: `grep -rn ${name} apps/web --include=*.ts   # delete the .enqueue call inside the consumer's handle or open`,
      meta: { consumer: input.consumer },
    });
  }
}
