// Where a page's write is sent: the action's pin — resolved off the document the server stamped
// (`renderedActionPin`) — with `:param`s filled and dropped from the body by core's `fillWire`, the
// request `action.client()` makes; else `POST actionPath(name)` with the whole input, as always.

import type { ActionPin, PinnedActionMethod } from '@ultimat3/core/page';
import { actionPath, fillWire } from '@ultimat3/core/page';
import type { JsonValue } from './json';
import { MutationPathUnfilledError } from './page-errors';

export interface MutationWire {
  readonly method: PinnedActionMethod;
  readonly url: string;
  readonly body: JsonValue;
}

/** Refuses (`X_MUTATION_PATH_UNFILLED`) an input that leaves a `:param` of the pin unfilled. */
export function mutationWire(
  name: string,
  input: JsonValue,
  pin: ActionPin | undefined,
): MutationWire {
  if (pin === undefined) return { method: 'POST', url: actionPath(name), body: input };
  const filled = fillWire(pin.path, input);
  if (!filled.ok) {
    throw new MutationPathUnfilledError({
      name,
      path: pin.path,
      param: filled.missing,
      reason: filled.reason,
    });
  }
  // The input's own keys, minus the URL's: still JSON.
  return { method: pin.method, url: filled.url, body: filled.rest as JsonValue };
}
