// The streaming action's one refusal, `X_ACTION_STREAM_INVALID`: a declaration that says it streams
// and a handler that does not, or a chunk its own `stream` schema refuses.

import { UltimateError } from '@ultimat3/core/page';

const FIX =
  'async *handle({ input, ctx }) { yield chunk; return output; } — yield only what stream: declares';

export class ActionStreamInvalidError extends UltimateError {
  constructor(action: string, reason: string) {
    super({
      code: 'X_ACTION_STREAM_INVALID',
      cause: `action "${action}" declares stream: and ${reason}`,
      fix: FIX,
      meta: { action },
    });
  }
}
