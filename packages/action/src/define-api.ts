/**
 * The API registry: one call that turns an app's primitive modules into the registered,
 * projectable API surface. `apps/web/api/index.ts` calls it and nothing else, so importing
 * that module IS the boot — and the value it returns is also the type the RPC client is
 * shaped from, which is why there is no second list of names to keep in step.
 */

import { primitiveRegistrar, type RegisteredPrimitive } from '@ultimat3/core';
import { registerActions } from './registry';

/** A module namespace: `import * as postActions from './actions'`. */
export type ApiModule = Readonly<Record<string, unknown>>;

/** One module, or several — a feature per entry, never a list of name strings. */
export type ApiModules = ApiModule | readonly ApiModule[];

export interface ApiDef {
  readonly actions?: ApiModules;
  /** A mutator IS an action; it registers as one, on the same authz path. */
  readonly mutators?: ApiModules;
  readonly queries?: ApiModules;
  /** `llm()` returns an action, so a model call registers exactly like every other one. */
  readonly llm?: ApiModules;
}

type Get<TDef, TKey extends string> = TKey extends keyof TDef ? TDef[TKey] : undefined;

/**
 * The exports a registrar would take, and only those. A feature module legitimately exports its
 * own helpers next to its primitives; carrying one into `Api['actions']` would offer the client a
 * method the server never registered and no surface can project.
 */
type Registered<TModule, TKind extends string> = {
  readonly [K in keyof TModule as TModule[K] extends { readonly kind: TKind }
    ? K
    : never]: TModule[K];
};

/**
 * Intersect a tuple of module namespaces. `{ createPost } & { inviteMember }` is the map the
 * typed client indexes, so `rpc<Api['actions']>()` knows every action without a codegen step.
 */
type Merge<TModules, TKind extends string> = [TModules] extends [undefined]
  ? EmptyModule
  : TModules extends readonly [infer THead, ...infer TRest]
    ? Registered<THead, TKind> & Merge<TRest, TKind>
    : TModules extends readonly []
      ? EmptyModule
      : Registered<TModules, TKind>;

type EmptyModule = Readonly<Record<never, never>>;

/** What `defineApi` returns: the registered primitives, merged and keyed by export name. */
export interface Api<TDef extends ApiDef> {
  readonly actions: Merge<Get<TDef, 'actions'>, 'action'> &
    Merge<Get<TDef, 'mutators'>, 'action'> &
    Merge<Get<TDef, 'llm'>, 'action'>;
  readonly queries: Merge<Get<TDef, 'queries'>, 'query'>;
}

/**
 * Register every primitive the app exposes, in one call.
 *
 * ```ts
 * export const api = defineApi({
 *   actions: [postActions, orgActions],
 *   mutators: [postMutators],
 *   queries: [postQueries],
 * });
 * ```
 *
 * Names come from export names, so two features exporting one name collide here with
 * `X_ACTION_DUPLICATE` instead of merging silently. Actions, mutators and `llm()` calls all
 * land in the action registry — they are the same primitive. Queries reach their own registry
 * through core's registrar table, because `@ultimat3/query` is on this tier and importing it
 * sideways is a build error.
 */
export function defineApi<const TDef extends ApiDef>(def: TDef): Api<TDef> {
  const actionModules = [
    ...moduleList(def.actions),
    ...moduleList(def.mutators),
    ...moduleList(def.llm),
  ];
  const queryModules = moduleList(def.queries);

  const actions: RegisteredPrimitive[] = [];
  for (const module of actionModules) actions.push(...registerActions(module));

  // Resolved once, and only when there is something to register: a missing registrar with
  // queries to register must be an error, never a silent skip that drops every read.
  const queries: RegisteredPrimitive[] = [];
  if (queryModules.length > 0) {
    const registerQueries = primitiveRegistrar('query');
    for (const module of queryModules) queries.push(...registerQueries(module));
  }

  return Object.freeze({
    actions: byRegisteredName(actions),
    queries: byRegisteredName(queries),
  }) as Api<TDef>;
}

function moduleList(modules: ApiModules | undefined): readonly ApiModule[] {
  if (modules === undefined) return [];
  return Array.isArray(modules) ? modules : [modules as ApiModule];
}

/**
 * Keyed by the name registration stamped, read back off the registrar's own results — never off
 * the module's exports. Copying every export would seat a feature's helper in `api.actions` under
 * a name no surface serves, and the last module exporting that name would win in silence.
 */
function byRegisteredName(primitives: readonly RegisteredPrimitive[]): ApiModule {
  const map: Record<string, RegisteredPrimitive> = {};
  for (const primitive of primitives) map[primitive.name] = primitive;
  return Object.freeze(map);
}
