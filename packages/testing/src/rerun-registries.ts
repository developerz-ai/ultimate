// The process registries a framework test file declares into, each as `rerun-declarations.ts`
// reads one: a lister and an exact restore from the package that owns it. Only those loaded by
// now — importing a package to forget its names would put its graph into every `packages/core`
// test (`registry-isolation.ts`'s reason) — and each one read through the `require` cache.

import type { AnyAction, listActions } from '@ultimat3/action';
import type { restoreActions } from '@ultimat3/action/loader';
import type {
  OAuthProvider,
  registeredOAuthProviders,
  restoreOAuthProviders,
} from '@ultimat3/auth';
import type { ServiceRegistration } from '@ultimat3/core';
import { registeredServices, restoreServices } from '@ultimat3/core';
import type {
  clearRegistry,
  RegistryEntry,
  registerEntity,
  registeredEntities,
} from '@ultimat3/entity';
import type { AnyJobHandle } from '@ultimat3/jobs';
import { registeredJobs, restoreJobs } from '@ultimat3/jobs';
import type {
  AnyMailDefinition,
  LayoutRegistration,
  layoutFor,
  registeredLayouts,
  registeredMails,
  restoreLayouts,
  restoreMails,
} from '@ultimat3/mail';
import type { AnyQuery, listQueries, resetQueries } from '@ultimat3/query';
import type { registerQuery } from '@ultimat3/query/loader';
import { loaded } from './per-test-reset';
import type { DeclarationRegistry } from './rerun-declarations';

/**
 * One registry over its package's own `registeredX()` / `restoreX(entries)` pair. `exportedAs` is
 * what a module that declared `entry` exports for it: the entry itself unless the registry wraps.
 */
export function listedRegistry<E>(
  kind: string,
  read: () => readonly E[],
  nameOf: (entry: E) => string,
  restore: (entries: readonly E[]) => void,
  exportedAs: (entry: E, value: unknown) => boolean = (entry, value) => value === entry,
): DeclarationRegistry {
  return {
    kind,
    names: () => read().map(nameOf),
    forget(names) {
      const all = read();
      restore(all.filter((entry) => !names.has(nameOf(entry))));
      return all.filter((entry) => names.has(nameOf(entry)));
    },
    putBack(entries) {
      const live = read();
      const present = new Set(live.map(nameOf));
      const missing = (entries as readonly E[]).filter((entry) => !present.has(nameOf(entry)));
      if (missing.length > 0) restore([...live, ...missing]);
    },
    exported(name, values) {
      const entry = read().find((candidate) => nameOf(candidate) === name);
      return entry !== undefined && values.some((value) => exportedAs(entry, value));
    },
  };
}

/** Jobs: `@ultimat3/jobs` is already in every test's graph (`registry-snapshot.ts` imports it). */
const jobRegistry = listedRegistry<AnyJobHandle>(
  'job',
  registeredJobs,
  (handle) => handle.name,
  restoreJobs,
);

/** Services: `@ultimat3/core` is in every graph. */
const serviceRegistry = listedRegistry<ServiceRegistration>(
  'service',
  registeredServices,
  (entry) => entry.name,
  restoreServices,
  (entry, value) => value === entry.factory,
);

const isProvider = (
  value: unknown,
): value is { readonly id: unknown; readonly tokenUrl: unknown } =>
  typeof value === 'object' && value !== null && 'id' in value && 'tokenUrl' in value;

interface EntityModule {
  readonly registeredEntities: typeof registeredEntities;
  readonly registerEntity: typeof registerEntity;
  readonly clearRegistry: typeof clearRegistry;
}
interface ActionModule {
  readonly listActions: typeof listActions;
  readonly restoreActions: typeof restoreActions;
}
interface QueryModule {
  readonly listQueries: typeof listQueries;
  readonly resetQueries: typeof resetQueries;
  readonly registerQuery: typeof registerQuery;
}
interface MailModule {
  readonly registeredMails: typeof registeredMails;
  readonly restoreMails: typeof restoreMails;
}
interface LayoutModule {
  readonly registeredLayouts: typeof registeredLayouts;
  readonly layoutFor: typeof layoutFor;
  readonly restoreLayouts: typeof restoreLayouts;
}
interface OAuthModule {
  readonly registeredOAuthProviders: typeof registeredOAuthProviders;
  readonly restoreOAuthProviders: typeof restoreOAuthProviders;
}

/**
 * `file` of `pkg` when this process already loaded it. Synchronous, as the body hooks are: the
 * module is in the cache, so `require` evaluates nothing.
 */
function moduleOf<M>(pkg: string, file: string): M | undefined {
  const path = loaded(pkg, file);
  return path === undefined ? undefined : (require(path) as M);
}

/** The entity registry has no exact restore of its own; clear-and-register is one. */
const entityRegistry = (module: EntityModule): DeclarationRegistry =>
  listedRegistry<RegistryEntry>(
    'entity',
    module.registeredEntities,
    (entry) => entry.name,
    (entries) => {
      module.clearRegistry();
      for (const entry of entries) module.registerEntity(entry);
    },
    // A module exports the entity, which the registry entry carries as `core`.
    (entry, value) => value === entry || (entry.core !== undefined && value === entry.core),
  );

/** Nor has the query registry; a reset that clears only the map, and each one back by name. */
const queryRegistry = (module: QueryModule): DeclarationRegistry =>
  listedRegistry<AnyQuery>(
    'query',
    module.listQueries,
    (entry) => entry.name,
    (entries) => {
      module.resetQueries();
      for (const entry of entries) module.registerQuery(entry.name, entry);
    },
  );

/** Layouts are listed by name; the entry handed back is the name with what it resolves to. */
const layoutRegistry = (module: LayoutModule): DeclarationRegistry =>
  listedRegistry<LayoutRegistration>(
    'mail-layout',
    () =>
      module.registeredLayouts().flatMap((name) => {
        const layout = module.layoutFor(name);
        return layout === undefined ? [] : [{ name, layout }];
      }),
    (entry) => entry.name,
    module.restoreLayouts,
    (entry, value) => value === entry.layout,
  );

/** The registries a framework test file declares into, as loaded right now. */
export function frameworkDeclarationRegistries(): readonly DeclarationRegistry[] {
  const registries = [jobRegistry, serviceRegistry];
  const entities = moduleOf<EntityModule>('@ultimat3/entity', 'registry.ts');
  if (entities !== undefined) registries.push(entityRegistry(entities));
  const actions = moduleOf<ActionModule>('@ultimat3/action', 'registry.ts');
  if (actions !== undefined) {
    registries.push(
      listedRegistry<AnyAction>(
        'action',
        actions.listActions,
        (entry) => entry.name,
        actions.restoreActions,
      ),
    );
  }
  const queries = moduleOf<QueryModule>('@ultimat3/query', 'registry.ts');
  if (queries !== undefined) registries.push(queryRegistry(queries));
  const mails = moduleOf<MailModule>('@ultimat3/mail', 'mail.ts');
  if (mails !== undefined) {
    registries.push(
      listedRegistry<AnyMailDefinition>(
        'mail',
        mails.registeredMails,
        (entry) => entry.id,
        mails.restoreMails,
      ),
    );
  }
  const layouts = moduleOf<LayoutModule>('@ultimat3/mail', 'layout.ts');
  if (layouts !== undefined) registries.push(layoutRegistry(layouts));
  const oauth = moduleOf<OAuthModule>('@ultimat3/auth', 'oauth-registry.ts');
  if (oauth !== undefined) {
    registries.push(
      listedRegistry<OAuthProvider>(
        'oauth-provider',
        oauth.registeredOAuthProviders,
        (entry) => entry.id,
        oauth.restoreOAuthProviders,
        // Sealed on the way in, so the registry holds a copy of what the module exports.
        (entry, value) => isProvider(value) && value.id === entry.id,
      ),
    );
  }
  return registries;
}
