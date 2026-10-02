// Which tenant a live window belongs to, and the id that keeps two tenants' windows apart.
//
// A window is the SHARED, pre-policy read of one `(query, input)`. Shared across every subscriber
// of one org it is the fan-out the pipeline is built on; shared across two orgs it is one org's
// rows in a window the other is served from, with a row policy as the only thing in between. So
// the tenant is part of the window's identity — the same place `@ultimat3/query`'s read cache puts
// its authority — and the read under it runs in a context that carries that tenant
// (`live-definition.ts`), which is where `@ultimat3/entity`'s guard takes it from on every surface.

import type { Actor } from '@ultimat3/core';

/** The org a subscriber's windows are read for. `null`: anonymous, or an actor in no org. */
export function liveTenantOf(actor: Actor | null): string | null {
  const orgId = actor?.orgId;
  return typeof orgId === 'string' && orgId !== '' ? orgId : null;
}

/**
 * One window's id: the query id, qualified by the tenant it is read for. JSON for the reason
 * `readAuthority` gives — an org id is app data and may carry any separator, and a value that can
 * spell a boundary can spell someone else's. An org-less window keeps the bare query id.
 */
export function windowId(queryId: string, tenant: string | null): string {
  return tenant === null ? queryId : JSON.stringify([queryId, tenant]);
}
