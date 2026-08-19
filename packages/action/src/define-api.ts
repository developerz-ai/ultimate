/**
 * The API registry: one call that turns an app's primitive modules into the registered,
 * projectable API surface. `apps/web/api/index.ts` calls it and nothing else, so importing
 * that module IS the boot — and the value it returns is also the type the RPC client is
 * shaped from, which is why there is no second list of names to keep in step.
 */

import { type PrimitiveKind, primitiveRegistrar, type RegisteredPrimitive } from '@ultimat3/core';
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
  /** The export name becomes the durable queue key — a job row names the handle, not a counter. */
  readonly jobs?: ApiModules;
  /** A task only enqueues jobs; handing it over here is what names its cron after its export. */
  readonly tasks?: ApiModules;
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
  readonly jobs: Merge<Get<TDef, 'jobs'>, 'job'>;
  readonly tasks: Merge<Get<TDef, 'tasks'>, 'task'>;
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
 * land in the action registry — they are the same primitive. Queries, jobs and tasks reach
 * their own registries through core's registrar table, because `@ultimat3/query` and
 * `@ultimat3/jobs` are on this tier and importing either sideways is a build error.
 */
export function defineApi<const TDef extends ApiDef>(def: TDef): Api<TDef> {
  const actionModules = [
    ...moduleList(def.actions),
    ...moduleList(def.mutators),
    ...moduleList(def.llm),
  ];

  const actions: RegisteredPrimitive[] = [];
  for (const module of actionModules) actions.push(...registerActions(module));

  const queries = registerThrough('query', moduleList(def.queries));
  // Jobs before tasks: a task's descriptor lists the jobs it enqueues by name, so registering
  // the other way round would read the queue keys one boot step before they were assigned.
  const jobs = registerThrough('job', moduleList(def.jobs));
  const tasks = registerThrough('task', moduleList(def.tasks));

  return Object.freeze({
    actions: byRegisteredName(actions),
    queries: byRegisteredName(queries),
    jobs: byRegisteredName(jobs),
    tasks: byRegisteredName(tasks),
  }) as Api<TDef>;
}

/**
 * Hand `modules` to the package that owns `kind`, through core's registrar table. Resolved only
 * when there is something to register: a missing registrar with modules in hand must be an
 * error, never a silent skip that drops every primitive of that kind.
 */
function registerThrough(
  kind: PrimitiveKind,
  modules: readonly ApiModule[],
): readonly RegisteredPrimitive[] {
  if (modules.length === 0) return [];
  const register = primitiveRegistrar(kind);
  const registered: RegisteredPrimitive[] = [];
  for (const module of modules) registered.push(...register(module));
  return registered;
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
  // A null-prototype map, because `name` is an export name and `map['__proto__'] = value` on a
  // plain object runs the PROTOTYPE SETTER instead of adding a key: the primitive would vanish
  // from `Object.keys`, from `api.actions` and from `rpc()`, while `registerPrimitive` reported
  // it registered. `Object.create(null)` has no such accessor, so the assignment is a key.
  const map: Record<string, RegisteredPrimitive> = Object.create(null) as Record<
    string,
    RegisteredPrimitive
  >;
  for (const primitive of primitives) map[primitive.name] = primitive;
  return Object.freeze(map);
}
