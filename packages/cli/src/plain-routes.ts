// The plain routes both boots mount and `x routes` lists: `apps/<app>/runtime.ts`'s `routes`, then
// every declared `webhookReceiver()`'s. Declaring a receiver is its one registration; a route the
// app also named by hand is mounted once, never twice (`X_ROUTE_CONFLICT`).

import type { Route } from '@ultimat3/http';
import { webhookReceiverRoutes } from '@ultimat3/jobs';

/** Called after the app's modules loaded: the receivers are read off the job registry. */
export function plainRoutes(declared: readonly Route[] | undefined): readonly Route[] {
  const own = declared ?? [];
  const named = new Set(own);
  return [...own, ...webhookReceiverRoutes().filter((route) => !named.has(route))];
}
