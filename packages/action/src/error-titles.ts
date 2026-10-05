// @ultimat3/action's error TITLES, registered at import — the one module `sideEffects` names, so
// `errors.ts` (the classes) is unlisted and a chunk carries it only where it constructs a class:
// Bun >= 1.4.1 honours the array and keeps a listed module wherever the barrel reaches it.
// `index.ts` imports this bare, because `problemError` rebuilds a server's refusal by code and reads
// its title from the registry; `errors.ts` and its two siblings import it bare as well.

import { registerErrorCodes } from '@ultimat3/core';

/**
 * Titles for the framework-wide code table — every one of them owned by this package.
 * `X_INPUT_INVALID` and `X_RPC_FAILED` are action's: an action is where an input schema is
 * enforced and where the typed client speaks, and `@ultimat3/query` only throws them.
 * Authz codes are absent on purpose — `ActionDeniedError` re-uses the policy decision's code.
 */
export const ACTION_ERROR_TITLES: Readonly<Record<string, string>> = {
  X_ACTION_DUPLICATE: 'two actions are registered under one name',
  X_AUDIT_SINK_FAILED: 'an audited action ran and the audit sink refused its record',
  X_AUDIT_SINK_MISSING: 'an action declares audit: true and no audit sink is installed',
  X_ACTION_DEPRECATION_INVALID: 'an action declares a deprecation whose dates cannot be rendered',
  X_ACTION_PATH_DUPLICATE: 'two actions derive one HTTP path',
  X_ACTION_FOREIGN: 'a value that is not an action was projected as one',
  X_ACTION_POLICY_MISSING: 'an action was registered without a policy',
  X_ACTION_UNREGISTERED: 'an action was projected before it was registered',
  X_CONTRACT_DRIFT: 'client and server disagree about the contract',
  X_IDEMPOTENCY_CONFLICT: 'idempotency key reused with a different payload or still in flight',
  X_IDEMPOTENCY_KEY_INVALID: 'an Idempotency-Key was sent that cannot identify one request',
  X_IDEMPOTENCY_NOT_SHARED:
    'idempotency is declared fleet-wide and the installed store is per-process',
  X_IDEMPOTENCY_REPLAYED_FAILURE:
    'a retried Idempotency-Key replays a first attempt that failed after it may have committed',
  X_IDEMPOTENCY_STATUS_UNKNOWN: 'an idempotency record holds a status this build cannot read',
  X_INPUT_INVALID: 'input failed schema validation',
  X_MUTATOR_CLOCK_MISSING:
    "a mutator declares conflict: 'last-write-wins' and its entity has no number clock column",
  X_OUTPUT_INVALID: 'a handler returned a value its output schema rejects',
  X_RPC_FAILED: 'an RPC call failed without a problem+json body',
  X_ACTION_HTTP_PATH_INVALID: "an action's pinned http.path is not a static lowercase path",
  X_ACTION_PATH_STYLE_INVALID: "defineApi's http.pathStyle is not a known style",
  X_OPENAPI_CONFIG_INVALID: "defineApi's openapi block cannot produce a valid document",
  X_ACTION_PATH_DERIVED_EARLY: 'a path was derived before pathStyle changed',
  X_MUTATOR_NOT_IDEMPOTENT: 'a mutator is declared without idempotent: true',
  X_IDEMPOTENCY_RESERVATION_LOST:
    "an idempotent action's reservation was taken over before its transaction could settle it",
  X_IDEMPOTENT_REPLAY_REDACTED: 'an idempotent replay would return a field redacted at rest',
};

// One unconditional call: a presence guard would turn "another package claims one of these codes"
// from an X_ERROR_CODE_DUPLICATE at import into whichever module loaded first deciding the title.
registerErrorCodes(
  Object.fromEntries(Object.entries(ACTION_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);
