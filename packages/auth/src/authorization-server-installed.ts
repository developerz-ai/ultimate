// Single responsibility: the `authServerStore` port's slot — where `authorizationServer()` keeps its
// clients, codes, grants and tokens when the app names no store. The boot installs `runtime.ts`'s;
// with none installed it is the env default, `postgresAuthServerStore` over the app's pool.

import { adapterSlot } from '@ultimat3/core/adapter';
import { dbExecutor } from '@ultimat3/db';
import { postgresAuthServerStore } from './authorization-server-postgres';
import type { AuthServerStore } from './authorization-server-store';

/** Core's one slot shape (`adapter-slot.ts`): installs stack, each release removes its own frame. */
const stores = /* @__PURE__ */ adapterSlot<AuthServerStore | undefined>(() => undefined);

/**
 * The `authServerStore` port's installer — on `@ultimat3/auth/adapter` only: the boot calls it with
 * `runtime.ts`'s `authServerStore`. Answers the release that removes THIS install and no other.
 */
export function installAuthServerStore(store: AuthServerStore): () => void {
  return stores.install(store);
}

/**
 * What a server declaring no `store` reads at EACH call — never captured, because `runtime.ts`
 * may import the module that builds the server before the boot installs this port. Nothing installed: Postgres over the ambient
 * pool, the store every app wrote by hand before 31.0.0 (`postgresAuthServerStore({ executor:
 * dbExecutor() })`); building it dials nothing.
 */
export function installedAuthServerStore(): AuthServerStore {
  return stores.current() ?? postgresAuthServerStore({ executor: dbExecutor() });
}

/** Test seam: every install dropped. On `./adapter`, beside the installer. */
export function resetAuthServerStore(): void {
  stores.reset();
}
