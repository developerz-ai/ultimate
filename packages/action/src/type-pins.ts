// Compile-time pins for the erased action view. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level claim written in one can never fail. This module emits nothing and exports nothing
// anybody imports — a regression here is a build error, the only enforcement that counts.

import type { AuditRecord, McpExposureDeclaration, Row } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Action, ActionDef, AnyAction, AnyActionDef } from './action';
import type { ClientMethod } from './client';
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStore,
} from './idempotency';
import type { ActionJobHandle } from './job-handle';
import type { LocalTable, MutatorDef } from './mutator';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * IDENTICAL, not merely mutually assignable: an object type without an optional key is assignable
 * to one with it and back, so `Equals` cannot see an optional field added on one side only — and
 * every field of the `mcp` block is optional but `expose`.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type PublishInput = StandardSchemaV1<{ readonly postId: string }>;
type PublishOutput = StandardSchemaV1<{ readonly published: boolean }>;
type PublishPost = Action<PublishInput, PublishOutput>;

/**
 * The registry hands back `AnyAction` and nothing else, so the erased view has to project every
 * surface — the queue included. Written as the return type rather than `'job' in keyof` because
 * an `AnyAction['job']` that answered the wrong shape would satisfy a key check.
 */
export type _ErasedViewProjectsAJobHandle = Assert<
  Equals<ReturnType<AnyAction['job']>, ActionJobHandle>
>;

/** …and the typed action still narrows it to its own schemas, which is what `.job()` is for. */
export type _TypedActionNarrowsTheJobHandle = Assert<
  Equals<ReturnType<PublishPost['job']>, ActionJobHandle<PublishInput, PublishOutput>>
>;

/**
 * Why `client()` is NOT on the erased view, pinned rather than asserted in a comment: a
 * `ClientMethod` is a function type, so its input is checked contravariantly and the erased
 * `(input: unknown) => …` is a supertype of no concrete action's method. Spelling `ClientMethod`
 * with method syntax — or with an `any` — would flip this to `true` and make the asymmetry
 * between `job()` and `client()` look arbitrary.
 */
export type _ErasedClientIsNotASupertype = Assert<
  ClientMethod<PublishInput, PublishOutput> extends ClientMethod<StandardSchemaV1, StandardSchemaV1>
    ? false
    : true
>;

/**
 * A mutator's `tx` table is `@ultimat3/realtime`'s store tx, member for member — the store is what
 * a twin runs against, so a member here it lacks is a twin that typechecks and throws. Pinned by
 * the member set because realtime (tier 3, sideways) cannot be imported to compare the types.
 */
export type _LocalTableIsTheStoreTxShape = Assert<
  Equals<keyof LocalTable, 'get' | 'all' | 'insert' | 'upsert' | 'update' | 'delete'>
>;

/** Addressed by KEY: an insert names the key its server twin answers under, never a column. */
export type _LocalInsertTakesTheKey = Assert<
  Equals<Parameters<LocalTable['insert']>, [key: string, row: Row]>
>;

/**
 * #591: a store written before answers were redacted at rest drops `settle`'s `redacted` flag and
 * would replay `[redacted]` as the answer. A required 4th PARAMETER cannot refuse it — TypeScript
 * accepts an implementation with fewer parameters — so the store DECLARES it keeps the flag
 * (`keepsRedaction: true`), and a pre-25 store without the declaration is a build error here.
 */
interface PreRedactionStore {
  readonly scope?: IdempotencyScope | undefined;
  reserve(key: string, requestHash: string): Promise<IdempotencyReservation>;
  settle(key: string, value: unknown, reservationId: string): Promise<void>;
  release(key: string): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
}

export type _APreRedactionStoreIsNotAStore = Assert<
  Equals<PreRedactionStore extends IdempotencyStore ? true : false, false>
>;

/** …and `settle`'s flag is required of every CALLER, so a wrapping store cannot drop it either. */
export type _SettleRequiresTheRedactedFlag = Assert<
  Equals<Parameters<IdempotencyStore['settle']>['length'], 4>
>;

/**
 * 25.0.0 (plan 101, M9): `name` and `primitive` are REQUIRED on an audit record and the `action`
 * alias is gone. Pinned as keys rather than with a literal record, because a literal would need a
 * `Ctx` this module has no business building: a field that turned optional again, or an alias
 * that came back, flips one of these to `false`.
 */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

export type _AuditRecordRequiresNameAndPrimitive = Assert<
  Equals<Extract<RequiredKeys<AuditRecord>, 'name' | 'primitive'>, 'name' | 'primitive'>
>;

export type _AuditRecordHasNoActionAlias = Assert<
  Equals<Extract<keyof AuditRecord, 'action'>, never>
>;

/**
 * 25.0.0 (plan 101, M5): the deprecation TYPES are `@ultimat3/core`'s alone, as the helpers are.
 * A runtime test cannot see a type re-export, so each is an expected error: a re-export coming
 * back makes the directive unused, which `tsc` refuses.
 */
// @ts-expect-error — `Deprecation` is imported from `@ultimat3/core`, never from this barrel.
export type _NoDeprecationReexport = import('./index').Deprecation;
// @ts-expect-error — `DeprecationField` is imported from `@ultimat3/core`.
export type _NoDeprecationFieldReexport = import('./index').DeprecationField;
// @ts-expect-error — `DeprecationRender` is imported from `@ultimat3/core`.
export type _NoDeprecationRenderReexport = import('./index').DeprecationRender;

/**
 * O-tool, 25.0.0: an action projects no MCP tool of its own — `@ultimat3/mcp`'s `toolFrom`
 * is the one projection, and a tier-3 `.tool()` could only ever be a second one. A `tool` member
 * coming back on either view flips these to `false`.
 */
export type _AnActionHasNoToolTwin = Assert<Equals<Extract<keyof AnyAction, 'tool'>, never>>;
export type _ATypedActionHasNoToolTwin = Assert<Equals<Extract<keyof PublishPost, 'tool'>, never>>;

/**
 * 25.0.0: an action's `mcp` block is core's ONE `McpExposureDeclaration`, minus the list
 * whitelist an action has nothing to compose over — on the declaration, the erased declaration,
 * the erased action and a mutator alike. `ActionMcp` restated the block field by field (and
 * `McpAnnotationHints` its hints); a field drifting on either side flips these to `false`.
 */
type ActionBlock = Omit<McpExposureDeclaration, 'listParams'>;
export type _ActionDeclaresCoresBlock = Assert<
  Identical<NonNullable<ActionDef<PublishInput, PublishOutput>['mcp']>, ActionBlock>
>;
export type _ErasedActionDefDeclaresCoresBlock = Assert<
  Identical<NonNullable<AnyActionDef['mcp']>, ActionBlock>
>;
export type _AnyActionCarriesCoresBlock = Assert<
  Identical<NonNullable<AnyAction['mcp']>, ActionBlock>
>;
export type _MutatorDeclaresCoresBlock = Assert<
  Identical<NonNullable<MutatorDef<PublishInput, PublishOutput>['mcp']>, ActionBlock>
>;
// @ts-expect-error — `McpAnnotationHints` is `@ultimat3/core`'s, never this barrel's.
export type _NoAnnotationHintsTwin = import('./index').McpAnnotationHints;
