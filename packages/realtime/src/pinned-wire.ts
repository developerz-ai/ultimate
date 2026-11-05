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

const METHODS: readonly unknown[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * One leading `/` and no second, then printable ASCII only (`!`–`~`, the backslash cut out): no
 * scheme can open it, and no whitespace, control or `\` survives — a URL parser drops a tab or
 * newline (`/\t/host` reads as `//host`) and reads `\` as `/`. A stamped pin is plain ASCII.
 */
const SAME_ORIGIN_PATH = /^\/(?!\/)[!-[\]-~]*$/;

/**
 * The pin, when it is one this build would have stamped. Checked HERE, the one door every write
 * reaches the wire through — fresh off the document or replayed off disk — because the outbox's
 * entries come back from IndexedDB, which anything on the origin can rewrite: one check at the
 * wire covers every store a pin can rest in, where a check at each load would be one per store.
 */
function trustedPin(pin: unknown): ActionPin | undefined {
  if (typeof pin !== 'object' || pin === null) return undefined;
  const path: unknown = Reflect.get(pin, 'path');
  const method: unknown = Reflect.get(pin, 'method');
  if (typeof path !== 'string' || !SAME_ORIGIN_PATH.test(path) || !METHODS.includes(method)) {
    return undefined;
  }
  return pin as ActionPin;
}

/**
 * Refuses (`X_MUTATION_PATH_UNFILLED`) an input that leaves a `:param` of the pin unfilled. A pin
 * that is not a same-origin path and a known verb is dropped for `POST actionPath(name)`: the
 * server answers that URL or refuses it, and nothing leaves the origin.
 */
export function mutationWire(
  name: string,
  input: JsonValue,
  stored: ActionPin | undefined,
): MutationWire {
  const pin = trustedPin(stored);
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
