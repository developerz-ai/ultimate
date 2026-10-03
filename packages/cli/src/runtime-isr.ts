// The ISR controller a boot serves pages through: built, ATTACHED as the framework's revalidator,
// and handed back with the detach the boot puts on its stop list. One function for `x dev` and the
// container, so neither can build a controller `invalidateTags` never reaches (plan 101, s2-con #1).

import type { IsrController, IsrStore } from '@ultimat3/render/server';
import { createIsrController } from '@ultimat3/render/server';

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
}): AttachedIsr {
  const isr = createIsrController({
    buildId: options.buildId,
    ...(options.store === undefined ? {} : { store: options.store }),
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
