// Single responsibility: the `mcpConfirmationStore` port's slot — where `mcpConfirmations()` keeps
// its pending rows when the app names no store. The boot installs `runtime.ts`'s; with none
// installed it is the env default, `postgresConfirmationStore` over the app's pool.

import { adapterSlot } from '@ultimat3/core/adapter';
import { dbExecutor } from '@ultimat3/db';
import { postgresConfirmationStore } from './confirmation-postgres';
import type { McpConfirmationStore } from './confirmation-store';

/** Core's one slot shape (`adapter-slot.ts`): installs stack, each release removes its own frame. */
const stores = /* @__PURE__ */ adapterSlot<McpConfirmationStore | undefined>(() => undefined);

/**
 * The `mcpConfirmationStore` port's installer — on `@ultimat3/mcp/adapter` only: the boot calls it
 * with `runtime.ts`'s `mcpConfirmationStore`. Answers the release that removes THIS install alone.
 */
export function installConfirmationStore(store: McpConfirmationStore): () => void {
  return stores.install(store);
}

/**
 * What a declaration naming no `store` reads at EACH use — never captured, because `runtime.ts`
 * may import the declaration before the boot installs this port. Nothing installed: Postgres over the ambient pool — the store
 * every app wrote by hand before 31.0.0 (`postgresConfirmationStore({ executor: dbExecutor() })`);
 * building it dials nothing.
 */
export function installedConfirmationStore(): McpConfirmationStore {
  return stores.current() ?? postgresConfirmationStore({ executor: dbExecutor() });
}

/** Test seam: every install dropped. On `./adapter`, beside the installer. */
export function resetConfirmationStore(): void {
  stores.reset();
}
