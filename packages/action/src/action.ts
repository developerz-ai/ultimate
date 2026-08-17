/**
 * The `action` primitive: one server-authoritative mutation, declared once.
 * Every projection in this package (route, OpenAPI, client, MCP tool, job
 * handle, contract tests) reads this declaration — none of them re-declare it.
 */

import type { CacheTag } from '@ultimat3/cache';
import { tagKeys } from '@ultimat3/cache';
import type { Actor, Ctx } from '@ultimat3/core';
import { isMcpExposed } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { ClientMethod, ClientOptions } from './client';
import type { ContractTest, ContractTestOptions } from './contract-test';
import type { Deprecation } from './deprecation';
import { facadeFor } from './facade';
import type { OpenApiOperation } from './http';
import type { IdempotencyStore } from './idempotency';
import { actionName, defOf, hasDef, invoke, stashDef } from './invoke';
import type { ActionJobHandle } from './job-handle';
import type { JsonSchemaObject } from './json-schema';
import { jsonSchemaOf } from './json-schema';
import type { McpToolDescriptor } from './mcp-tool';
import { derivePath, toToolName } from './naming';
import {
  type ActionPolicy,
  policyCapability,
  policyPermissions,
  type Surface,
} from './policy-gate';

export interface ActionCache {
  /** Tags dropped from every cache tier after the handler settles. */
  readonly invalidates: readonly CacheTag[];
}

export interface ActionMcp {
  /** Opt-in: only a literal `true` makes the action a tool. Silence exposes nothing. */
  readonly expose: boolean;
  /**
   * Contract text, NOT UI text — deliberately outside `t()`. It becomes the OpenAPI
   * operation `summary` (`toOpenApiOperation`), and `buildOpenApi`'s bytes are what
   * `x verify` diffs for contract drift. Resolving it through the ambient, request-scoped
   * translator would make `openapi.json` depend on whichever locale happened to be active
   * when it was generated, which is exactly the determinism that file's header forbids.
   * Localised agent-facing text needs a separate, locale-resolved projection; there is no
   * second field for it here until that exists, because two ways to describe one tool is
   * the drift axiom 1 rejects.
   */
  readonly description?: string;
  /**
   * Roles that may SEE the projected tool. A CATALOG audience, never an authz rule — the
   * `policy` above still decides every call, and this list decides nothing about one. Omitted
   * means every caller may enumerate it.
   *
   * Fail-closed where it lands (`@ultimat3/mcp`): a caller whose role is not named — including
   * one carrying no role at all — gets the answer an ABSENT tool gets, never `Forbidden`.
   * Forbidden would confirm the tool exists, which turns the catalog into something an agent
   * can enumerate by probing names.
   *
   * A plain role list, never a predicate: a declared fact has to stay static and serialisable.
   * A surface deriving visibility from something richer (`@ultimat3/admin` derives it from the
   * actor's admin permissions) hands `@ultimat3/mcp` a predicate instead.
   */
  readonly visibleTo?: readonly string[];
}

export interface ActionRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ActionHandlerArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

/** What a row loader gets: the parsed input and the context, never the request. */
export interface ActionRowArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface ActionDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TRow = unknown,
> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly policy: ActionPolicy<TRow>;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  readonly rateLimit?: ActionRateLimit;
  /**
   * On its way out. Declared here and projected everywhere at once: `Deprecation` and `Sunset`
   * response headers (RFC 9745 / RFC 8594), a `rel="successor-version"` link when `replacedBy`
   * names one, `deprecated: true` in the OpenAPI operation, and a
   * `deprecated_calls_total{name}` counter — which is the only way to answer "is anyone
   * still calling it?" before deleting it.
   *
   * **Versioning is deliberately NOT here.** Running `v1` and `v2` of one action side by side is
   * two deployments behind one ingress, which is axiom 7's answer and costs this package no
   * router feature; see the README. What ships is the compat WINDOW: a date, a successor, and a
   * number.
   */
  readonly deprecated?: Deprecation;
  /** Marks the action safe to retry with an `Idempotency-Key`. */
  readonly idempotent?: boolean;
  /**
   * Record every attempt at this action through the installed `AuditSink` — allowed, denied and
   * failed alike. Opt-in per declaration and never a global switch: a login and a price change
   * are not the same event, and the framework is not the thing that knows which of them an app
   * has to keep. `true` with no sink installed is `X_AUDIT_SINK_MISSING`, refused before the
   * input parse.
   *
   * What the sink DOES with the record — which fields survive, how long, hash-chained or not,
   * indexed by subject or not — is the app's, and this package ships none of it.
   */
  readonly audit?: boolean;
  /**
   * Loads the row a row-level `policy` decides about, once per invocation, after the
   * input parse and before the guard. This is the async half authz is not allowed to
   * have: a predicate stays synchronous — a live query re-evaluates one per subscriber
   * on every change, so an `await` inside it would be a database round trip per row per
   * connected client. The caller loads what the rule needs and passes it in; here, the
   * caller is the framework.
   *
   * Omitted means the rule decides on input alone and `row` reaches it as `null`. A rule
   * that reads `row` must therefore fail closed on `null`, because "no loader declared"
   * and "row not found" are the same value and neither is evidence of permission.
   */
  row?(args: ActionRowArgs<TInput>): TRow | null | Promise<TRow | null>;
  handle(args: ActionHandlerArgs<TInput>): Promise<InferOutput<TOutput>> | InferOutput<TOutput>;
}

export interface InvokeOptions {
  /** Explicit context. Omitted means "take the ambient request context". */
  readonly ctx?: Ctx;
  /**
   * Run as someone else. Omitted keeps the context's own actor; `null` is the
   * signed-out caller. The rest of the context is untouched, so impersonation
   * stays on the one execution path instead of forking a second one.
   */
  readonly actor?: Actor | null;
  readonly surface?: Surface;
  readonly idempotencyKey?: string | null;
  readonly store?: IdempotencyStore;
  readonly onReplay?: () => void;
}

export interface McpDescriptorMeta {
  readonly expose: boolean;
  readonly tool: string;
  readonly description: string | null;
}

export interface ActionDescriptor {
  readonly kind: 'action';
  /**
   * Built by `mutator()`. `kind` cannot carry this: `describeActions()` hands back
   * `ActionDescriptor`, whose `kind` is the literal `'action'` for a mutator too — so every
   * reader downstream (`x.manifest.json`'s mutator count included) sees zero without it.
   */
  readonly mutator: boolean;
  readonly name: string;
  readonly verb: string;
  readonly resource: string;
  readonly method: 'POST';
  readonly path: string;
  /** The policy's DISPLAY label. A composite renders as `and(a:b, c:d)` — never a permission. */
  readonly capability: string;
  /**
   * Every permission the policy tree references, flattened. This is the field a compliance
   * report matches a grant against: `capability` is a label, so `x policy list` reported every
   * composite-guarded action's permissions as unenforced — real grants shown as dead.
   */
  readonly permissions: readonly string[];
  readonly input: JsonSchemaObject;
  readonly output: JsonSchemaObject;
  readonly invalidates: readonly string[];
  readonly idempotent: boolean;
  /**
   * Whether every attempt reaches the audit sink. Published here for the same reason
   * `idempotent` is: "which of these writes leave a trail" is a question an agent asks of
   * `x actions list --json`, and a fact nothing publishes is a fact nobody can check.
   */
  readonly audited: boolean;
  readonly mcp: McpDescriptorMeta;
  readonly rateLimit: ActionRateLimit | null;
  /** Published so `x actions list --json` can answer "what is retiring, and when". */
  readonly deprecated: Deprecation | null;
}

/**
 * Schema-erased view of a definition, held only by `invoke.ts`'s private store —
 * never reachable from an action. Members stay method-syntax on purpose:
 * bivariant parameters are what make the erasure assignable.
 */
export interface AnyActionDef {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly policy: ActionPolicy;
  readonly cache?: ActionCache;
  readonly mcp?: ActionMcp;
  readonly rateLimit?: ActionRateLimit;
  readonly deprecated?: Deprecation;
  readonly idempotent?: boolean;
  readonly audit?: boolean;
  row?(args: { readonly input: unknown; readonly ctx: Ctx }): unknown;
  handle(args: { readonly input: unknown; readonly ctx: Ctx }): unknown;
}

export interface AnyAction {
  readonly kind: 'action';
  readonly name: string;
  /** The declaration, minus `handle`: readable, and never a way to run it. */
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  describe(): ActionDescriptor;
  /** A twin under another name. Registration uses `nameAction`, which names in place. */
  named(name: string): AnyAction;
  /** Run as this actor. Same `invoke` core, only the context's actor changes. */
  as(actor: Actor | null, input: unknown, options?: InvokeOptions): Promise<unknown>;
  tool(): McpToolDescriptor;
  openapi(): OpenApiOperation;
  /**
   * The durable-work shape, erased. `listActions()` and `getAction(name)` hand back this view
   * and nothing else, so leaving `job()` off it meant the registry could project an action to
   * every surface except the queue — `getAction('publishPost')?.job()` was a type error against
   * an object that has had the method since `facadeFor` bound it.
   *
   * It erases where `client()` cannot: `ActionJobHandle`'s members are method-syntax, so their
   * parameters stay bivariant, and its output erases to `unknown`. `ClientMethod` is a function
   * type — contravariant input — and `(input: unknown) => …` is a supertype of nothing.
   * `type-pins.ts` holds both halves of that as build errors.
   */
  job(): ActionJobHandle;
  contract(options?: ContractTestOptions): readonly ContractTest[];
}

export interface Action<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TOutput extends StandardSchemaV1 = StandardSchemaV1,
> extends AnyAction {
  /** Callable server-side with the same types the client and MCP tool see. */
  (input: InferInput<TInput>, opts?: InvokeOptions): Promise<InferOutput<TOutput>>;
  readonly input: TInput;
  readonly output: TOutput;
  named(name: string): Action<TInput, TOutput>;
  as(
    actor: Actor | null,
    input: InferInput<TInput>,
    options?: InvokeOptions,
  ): Promise<InferOutput<TOutput>>;
  /**
   * Typed against this action's schemas, which is the whole point of it — and the reason
   * `client()` lives here alone: its input sits in a contravariant position, so no erased
   * spelling of it is assignable from a concrete one. `job()` is the narrowing of the erased
   * view's, not a second declaration of it.
   */
  client(options: ClientOptions): ClientMethod<TInput, TOutput>;
  job(): ActionJobHandle<TInput, TOutput>;
}

/** The fluent half of an action: lifted declaration plus one method per projection. */
export type ActionFacade<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1> = Pick<
  Action<TInput, TOutput>,
  'input' | 'output' | 'policy' | 'mcp' | 'as' | 'tool' | 'openapi' | 'client' | 'job' | 'contract'
>;

export function action<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TRow = unknown,
>(def: ActionDef<TInput, TOutput, TRow>): Action<TInput, TOutput> {
  return build(def, '');
}

/**
 * Structural, not nominal: an object only counts as an action if `action()` built
 * it, because only then does a declaration exist for `invoke` to run. A look-alike
 * with `kind: 'action'` never reaches the registry or a projection.
 */
export function isAction(value: unknown): value is AnyAction {
  return (
    typeof value === 'function' && (value as { kind?: unknown }).kind === 'action' && hasDef(value)
  );
}

/**
 * Stamp the export name onto the action the app declared, rather than handing back a
 * differently-named copy of it. `import { publishPost } from './actions'` is then the
 * action that projects — `publishPost.tool()` after boot, with nothing to remember.
 * Naming twice is the one case that still needs a twin: one object, one name, forever.
 */
export function nameAction<A extends AnyAction>(target: A, name: string): A {
  if (target.name === name) return target;
  if (target.name.length > 0) return target.named(name) as A;
  Object.defineProperty(target, 'name', { value: name, configurable: true });
  return target;
}

function build<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1, TRow>(
  def: ActionDef<TInput, TOutput, TRow>,
  name: string,
): Action<TInput, TOutput> {
  const callable = (
    input: InferInput<TInput>,
    opts: InvokeOptions = {},
  ): Promise<InferOutput<TOutput>> =>
    // `invoke` is schema-erased; the output type is this action's by construction.
    invoke(self, input, opts) as Promise<InferOutput<TOutput>>;

  const self: Action<TInput, TOutput> = Object.assign(callable, {
    kind: 'action' as const,
    describe: (): ActionDescriptor => describeAction(self),
    named: (next: string): Action<TInput, TOutput> => build(def, next),
    ...facadeFor(def, () => self),
  });
  // `name` on a function is non-writable, so Object.assign cannot set it.
  Object.defineProperty(self, 'name', { value: name, configurable: true });
  // The declaration goes to `invoke.ts` and stays there: `handle` has no other reader.
  stashDef(self, def);
  return self;
}

export function describeAction(target: AnyAction): ActionDescriptor {
  const name = actionName(target);
  const def = defOf(target);
  const path = derivePath(name);
  const mcp = def.mcp;
  return {
    kind: 'action',
    // The brand `mutator()`'s `wrap` stamps on the action it lifted, read structurally.
    // Importing `isMutator` would point this module at the one that already imports it, for a
    // check that needs the brand and not the predicate — `defOf` above already proved the rest.
    mutator: (target as { readonly isMutator?: unknown }).isMutator === true,
    name,
    verb: path.verb,
    resource: path.resource,
    method: 'POST',
    path: path.path,
    capability: policyCapability(def.policy),
    // The flattened list, beside the label and never instead of it: one is read, one is matched.
    permissions: policyPermissions(def.policy),
    input: jsonSchemaOf(def.input),
    output: jsonSchemaOf(def.output),
    invalidates: tagKeys(def.cache?.invalidates ?? []),
    idempotent: def.idempotent === true,
    audited: def.audit === true,
    mcp: {
      // `isMcpExposed`, not `?? true`: this fact is what the manifest publishes and what the
      // contract diff classifies, so it has to be the answer the tool projection actually gives.
      // Fail-open here published every action as a tool no surface would ever serve, which made
      // a first honest `expose: false` read as a withdrawn capability and demand a major bump.
      expose: isMcpExposed(mcp),
      tool: toToolName(name),
      description: mcp?.description ?? null,
    },
    rateLimit: def.rateLimit ?? null,
    deprecated: def.deprecated ?? null,
  };
}
