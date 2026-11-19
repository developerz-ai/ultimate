// A container boot over an idempotency store that keeps its records per process. The boot installs
// the shared Postgres store (`runtime-queue.ts`); an app module that swapped in a per-process one
// after it left `idempotent: true` meaning "once per replica" — with nothing to say so, because
// `assertIdempotencyScope` only fires on a `'shared'` DECLARATION and nothing infers a replica count.

import { getIdempotencyStore, type IdempotencyStore } from '@ultimat3/action';
import { logger, supervisedChild } from '@ultimat3/core';
import { unsharedStores } from './supervise-count';
import { ProcessesUnsharedStateError } from './supervise-errors';

/**
 * `true` when it warned. Said, not refused: one replica is a real deployment and is correct. In one
 * of several supervised children it IS refused — the supervisor could not see a store an app module
 * swapped in, and the siblings sharing this port would each answer a retry from their own records.
 */
export function warnIfIdempotencyProcessScoped(
  store: IdempotencyStore = getIdempotencyStore(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (store.scope === 'shared') return false;
  const child = supervisedChild(env);
  if (child !== undefined && child.count > 1) {
    throw new ProcessesUnsharedStateError({
      requested: child.count,
      reasons: unsharedStores([{ name: 'the idempotency store', scope: store.scope }]),
    });
  }
  logger.warn('X_CONFIG_INVALID', {
    code: 'X_CONFIG_INVALID',
    cause:
      'the idempotency store this process ended its boot with keeps records per process, so on more than one replica a retried idempotent action that lands on another replica runs its handler again — docker/helm/values.yaml runs roles.web.replicas: 3',
    // Declaring the scope is the enforcement: `assertIdempotencyScope` then refuses the store.
    fix: "configureIdempotency({ scope: 'shared' })",
    scope: store.scope ?? 'undeclared',
  });
  return true;
}
