// The ISR controller a boot serves pages through: built, ATTACHED as the framework's revalidator,
// and handed back with the detach the boot puts on its stop list. One function for `x dev` and the
// container, so neither can build a controller `invalidateTags` never reaches (plan 101, s2-con #1).

import { describePages, RouteModeInvalidError } from '@ultimat3/render';
import type { IsrController, IsrStore } from '@ultimat3/render/server';
import { isrController } from '@ultimat3/render/server';

export interface AttachedIsr {
  readonly isr: IsrController;
  /** Detaches the revalidator and drops this controller's graph edges; idempotent. */
  readonly release: () => void;
}

/**
 * Unattached, a `revalidate: { tags }` page (no TTL) is fresh until invalidated — and nothing
 * invalidates it: `invalidateTags` calls the registered revalidator, which was nobody.
 */
export function attachedIsr(options: {
  readonly buildId: string;
  readonly store?: IsrStore;
  /** `isrController`'s own; a test turns the cooldown off rather than waiting one out. */
  readonly failureCooldownMs?: number;
}): AttachedIsr {
  if (options.store !== undefined) assertPurgeSafe(options.store);
  const isr = isrController({
    buildId: options.buildId,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.failureCooldownMs === undefined
      ? {}
      : { failureCooldownMs: options.failureCooldownMs }),
  });
  const detach = isr.attach();
  let released = false;
  return {
    isr,
    release: () => {
      if (released) return;
      released = true;
      detach();
    },
  };
}

/**
 * A store the deployment supplied is one other processes may write. Under `onInvalidate: 'purge'`
 * a replica that began a render before the purge, and has not heard of it yet, writes the purged
 * page back unless the STORE refuses the write (`IsrStore.tagFence`) — its own fence only knows
 * the busts it was told about. Refused here, by route, rather than left to happen in production.
 */
function assertPurgeSafe(store: IsrStore): void {
  if (store.tagFence !== undefined) return;
  const purging = describePages().find((route) => route.revalidateOnInvalidate === 'purge');
  if (purging === undefined) return;
  throw new RouteModeInvalidError(
    `${purging.file} declares revalidate.onInvalidate: 'purge', and the runtime's isrStore has no tagFence — a replica whose render began before a purge would write the purged page back into it`,
    'tagFence: { sample, bump, setIfCurrent }   // implement IsrTagFence on the isrStore in apps/web/runtime.ts (setIfCurrent atomic in the store), or drop isrStore to keep one memory store per replica',
  );
}
