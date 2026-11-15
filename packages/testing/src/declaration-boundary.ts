// The module-scope declaration tables `registry-snapshot.ts` does not hold, put back at the file
// boundary to what the file's body inherited: realtime's channels and `@ultimat3/mcp`'s declared
// remote servers and served recipes. Each is read through the module cache, never imported — an
// unloaded package has nothing to restore, and `testing` does not depend on `@ultimat3/mcp`.

import type {
  AuthenticatorOptions,
  configureAuthenticator,
  configuredAuthenticator,
  configuredCredentialTtlMs,
  resetAuthenticator,
} from '@ultimat3/http';
import type { Channel } from '@ultimat3/realtime';
import type { RouteSnapshot, restoreRoutes, routeSnapshot } from '@ultimat3/render';
import { loaded } from './per-test-reset';

/** One table: where it lives, how to read it, and the exact restore its owner publishes. */
export interface DeclarationTable {
  /** `<package>/<file under src>` — the row `process-registries.test.ts` holds to the source. */
  readonly owner: string;
  /** `undefined` while the owner is unloaded. */
  capture(): unknown;
  /** Called with a defined snapshot only. */
  restore(snapshot: unknown): void;
}

interface ChannelModule {
  readonly registeredChannels: () => readonly Channel[];
  readonly restoreChannels: (declared: readonly Channel[]) => void;
}

interface RouteModule {
  readonly routeSnapshot: typeof routeSnapshot;
  readonly restoreRoutes: typeof restoreRoutes;
}

/** `@ultimat3/ai`'s catalogue, restated: `ai` is reached dynamically only, never type-imported. */
interface ModelModule {
  readonly registeredModels: () => readonly unknown[];
  readonly restoreModels: (specs: readonly unknown[]) => void;
}

interface HooksModule {
  readonly configureAuthenticator: typeof configureAuthenticator;
  readonly configuredAuthenticator: typeof configuredAuthenticator;
  readonly configuredCredentialTtlMs: typeof configuredCredentialTtlMs;
  readonly resetAuthenticator: typeof resetAuthenticator;
}

interface AuthenticatorSlot {
  readonly authenticate: ReturnType<typeof configuredAuthenticator>;
  readonly ttl: number | undefined;
}

/** `@ultimat3/mcp`'s shapes, restated: `testing` neither depends on nor type-imports the package. */
interface RecipeModule {
  readonly servedRecipes: () => ReadonlySet<string>;
  readonly resetServedRecipes: () => void;
  readonly noteServedRecipes: (names: readonly string[]) => void;
}
/** `@ultimat3/storage`'s registry, restated: `testing` does not depend on the package. */
interface StorageModule {
  readonly definedStorage: () => unknown;
  readonly resetStorage: () => void;
}

interface RemoteModule {
  readonly declaredMcpServers: () => ReadonlyMap<string, unknown>;
  readonly restoreDeclaredMcpServers: (servers: ReadonlyMap<string, unknown>) => void;
}

const found = new Map<string, string>();

/**
 * A loaded module whose path ends in `suffix` and that exports every name in `shape`. For a
 * package `testing` cannot resolve (not a dependency): the cache is scanned until it is seen,
 * then the path is kept. The shape check is what keeps an app's own `packages/mcp/src/` out.
 */
function cachedModule<M>(suffix: string, shape: readonly string[]): M | undefined {
  const known = found.get(suffix);
  if (known !== undefined) return require.cache[known]?.exports as M | undefined;
  for (const [path, entry] of Object.entries(require.cache)) {
    if (!path.replaceAll('\\', '/').endsWith(suffix)) continue;
    const exports = entry?.exports as Record<string, unknown> | undefined;
    if (exports === undefined || !shape.every((name) => typeof exports[name] === 'function')) {
      continue;
    }
    found.set(suffix, path);
    return exports as M;
  }
  return undefined;
}

const channelModule = (): ChannelModule | undefined => {
  const path = loaded('@ultimat3/realtime', 'channel-registry.ts');
  return path === undefined ? undefined : (require(path) as ChannelModule);
};

const routeModule = (): RouteModule | undefined => {
  const path = loaded('@ultimat3/render', 'registry.ts');
  return path === undefined ? undefined : (require(path) as RouteModule);
};

const modelModule = (): ModelModule | undefined => {
  const path = loaded('@ultimat3/ai', 'models.ts');
  return path === undefined ? undefined : (require(path) as ModelModule);
};

const hooksModule = (): HooksModule | undefined => {
  const path = loaded('@ultimat3/http', 'hooks.ts');
  return path === undefined ? undefined : (require(path) as HooksModule);
};

const STORAGE_SHAPE = ['definedStorage', 'defineStorage', 'resetStorage'] as const;
const storageModule = (): StorageModule | undefined =>
  cachedModule<StorageModule>('/storage/src/storage.ts', STORAGE_SHAPE);

const RECIPE_SHAPE = ['servedRecipes', 'resetServedRecipes', 'noteServedRecipes'] as const;
const REMOTE_SHAPE = ['declaredMcpServers', 'restoreDeclaredMcpServers'] as const;
const recipeModule = (): RecipeModule | undefined =>
  cachedModule<RecipeModule>('/mcp/src/recipe-links.ts', RECIPE_SHAPE);
const remoteModule = (): RemoteModule | undefined =>
  cachedModule<RemoteModule>('/mcp/src/remote-tools.ts', REMOTE_SHAPE);

/** Every table the boundary restores. A new module-scope registry joins here, with its restore. */
export const DECLARATION_TABLES: readonly DeclarationTable[] = [
  {
    // One file's `site/` route was a later fixture app's `budgets` red (`X_STYLES_GLOBAL_MISSING`
    // in `mcp-host-tools.test.ts`): `documentSurfaces()` reads the whole route table.
    owner: '@ultimat3/render/registry.ts',
    capture: () => routeModule()?.routeSnapshot(),
    restore: (snapshot) => routeModule()?.restoreRoutes(snapshot as RouteSnapshot),
  },
  {
    owner: '@ultimat3/ai/models.ts',
    capture: () => modelModule()?.registeredModels(),
    restore: (snapshot) => modelModule()?.restoreModels(snapshot as readonly unknown[]),
  },
  {
    // A slot, not a table: one file's `configureAuthenticator` answered every later file's socket
    // upgrade with its resolver — `role-sync-dev-origin.test.ts` read 401 where it wanted 101.
    owner: '@ultimat3/http/hooks.ts',
    capture: (): AuthenticatorSlot | undefined => {
      const module = hooksModule();
      return module === undefined
        ? undefined
        : {
            authenticate: module.configuredAuthenticator(),
            ttl: module.configuredCredentialTtlMs(),
          };
    },
    restore: (snapshot) => {
      const module = hooksModule();
      if (module === undefined) return;
      const { authenticate, ttl } = snapshot as AuthenticatorSlot;
      if (authenticate === undefined) return module.resetAuthenticator();
      const options: AuthenticatorOptions = ttl === undefined ? {} : { credentialTtlMs: ttl };
      module.configureAuthenticator(authenticate, options);
    },
  },
  {
    // A slot with a reset and no setter: a body that installed storage over NONE is undone; one
    // that replaced an inherited registry cannot be put back and is left (no exact writer exists).
    // One file's `defineStorage({ disks: { assets } })` was every later boot's `appDeclared()`.
    owner: '@ultimat3/storage/storage.ts',
    capture: () => {
      const module = storageModule();
      return module === undefined ? undefined : { storage: module.definedStorage() };
    },
    restore: (snapshot) => {
      const module = storageModule();
      if (module === undefined) return;
      if ((snapshot as { readonly storage: unknown }).storage === undefined) module.resetStorage();
    },
  },
  {
    owner: '@ultimat3/realtime/channel-registry.ts',
    capture: () => channelModule()?.registeredChannels(),
    restore: (snapshot) => {
      const module = channelModule();
      if (module !== undefined) module.restoreChannels(snapshot as readonly Channel[]);
    },
  },
  {
    owner: '@ultimat3/mcp/recipe-links.ts',
    capture: () => {
      const served = recipeModule()?.servedRecipes();
      return served === undefined ? undefined : [...served];
    },
    restore: (snapshot) => {
      const module = recipeModule();
      if (module === undefined) return;
      module.resetServedRecipes();
      module.noteServedRecipes(snapshot as readonly string[]);
    },
  },
  {
    owner: '@ultimat3/mcp/remote-tools.ts',
    capture: () => {
      const declared = remoteModule()?.declaredMcpServers();
      return declared === undefined ? undefined : new Map(declared);
    },
    restore: (snapshot) => {
      const module = remoteModule();
      if (module === undefined) return;
      module.restoreDeclaredMcpServers(snapshot as ReadonlyMap<string, unknown>);
    },
  },
];

/** Each table's contents now, in `DECLARATION_TABLES` order; `undefined` for an unloaded owner. */
export function captureDeclarationTables(): readonly unknown[] {
  return DECLARATION_TABLES.map((table) => table.capture());
}

/**
 * Exactly `snapshots` again. A table whose owner was not loaded at the capture is left alone: what
 * it holds was declared by a module this file loaded lazily, at module scope — a cached module
 * never declares again, so taking it away would cost every later file that imports it.
 */
export function restoreDeclarationTables(snapshots: readonly unknown[]): void {
  DECLARATION_TABLES.forEach((table, index) => {
    const snapshot = snapshots[index];
    if (snapshot !== undefined) table.restore(snapshot);
  });
}
