/**
 * Public API of @ultimat3/action: the primitive plus its six projections.
 *
 * `handle` is deliberately absent. An action's declaration lives in `invoke.ts`'s
 * private store, and `invoke` is the only thing that reads it — so no adapter can
 * parse, authorize or run on its own. Two authz systems is how every Meteor-like
 * framework died; there is exactly one here, structurally.
 */

// Imported bare, and the one module `sideEffects` lists: a browser that rebuilds a SERVER's refusal
// (`problemError`, by code) constructs nothing from `errors.ts`, and still has to render the title
// this package registered. `SIDE_EFFECTS_ANCHORS` carries the argument and `bun run side-effects`
// enforces it.
import './error-titles';

/**
 * Types only: the barrel's own declarations name them. Flight control's VALUES are imported from
 * `@ultimat3/core`, which holds the one pipeline for action and query alike; a value re-export
 * here is `X_HELPER_COPY`.
 */
export type { ClientFlight, ClientRetry, PgExecutor } from '@ultimat3/core';
/** Re-exported so an `action` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type {
  Action,
  ActionCache,
  ActionDef,
  ActionDescriptor,
  ActionFacade,
  ActionHandlerArgs,
  ActionMcp,
  ActionRateLimit,
  ActionRowArgs,
  AnyAction,
  InvokeOptions,
  McpDescriptorMeta,
} from './action';
export { action, describeAction, isAction } from './action';
/**
 * The app's API as a whole — `defineApi({ http: { pathStyle, mounts }, openapi })` — read back by
 * the boot (bearer mounts) and `x manifest` (the complete and per-mount documents).
 */
export type {
  ApiDeclaration,
  ApiHttp,
  ApiMount,
  ApiOpenApi,
  OpenApiServer,
} from './api-declaration';
export { apiDeclaration } from './api-declaration';
/**
 * The audit seam. `AuditSink` is the whole extension point: the framework supplies the record
 * and never the row. `audit-gate.ts` stays unexported — the sink has one caller, and that
 * absence is what keeps it one. The record and the sink are `@ultimat3/core`'s, re-exported as
 * TYPES only because this barrel's sinks name them; the slot (`setAuditSink`) is core's alone.
 */
export type { AuditRecord, AuditSink } from './audit';
export { AUDIT_INPUT_MAX_DEPTH, auditableInput, UNREPRESENTABLE } from './audit-input';
export type { MemoryAuditSink, MemoryAuditSinkOptions } from './audit-memory';
export { DEFAULT_MAX_AUDIT_RECORDS, memoryAuditSink } from './audit-memory';
/**
 * The DURABLE sink, and the only one an app that must keep its trail may install. The table's DDL
 * is exported beside it because the table is applied the way `SQL_IDEMPOTENCY_TABLE` is — by the
 * boot, never by an app migration. The insert is not: it is the sink's own statement, and an
 * export with no reader outside this package is `X_SQL_EXPORT_UNREAD` (`bun run sql-export-readers`).
 */
export type { PostgresAuditSink, PostgresAuditSinkOptions } from './audit-postgres';
export { postgresAuditSink, SQL_AUDIT_TABLE } from './audit-postgres';
export type {
  ActionLike,
  ActionMap,
  CallOptions,
  Client,
  ClientMethod,
  ClientOptions,
  FetchLike,
} from './client';
export { rpc } from './client';
export type { ContractTest, ContractTestOptions } from './contract-test';
export { anonymousCtx, contractTestsFor, policyTestStubFor } from './contract-test';
export type { Api, ApiDef, ApiModule, ApiModules } from './define-api';
export { defineApi } from './define-api';
export type { IdempotencyConflictReason, IdempotencyKeyProblem, RemoteFailure } from './errors';
export {
  ActionDeniedError,
  ActionDeprecationInvalidError,
  ActionDuplicateError,
  ActionForeignError,
  ActionPathDuplicateError,
  ActionPolicyMissingError,
  ActionUnregisteredError,
  AuditSinkFailedError,
  AuditSinkMissingError,
  ContractDriftError,
  IdempotencyConflictError,
  IdempotencyKeyInvalidError,
  IdempotencyNotSharedError,
  IdempotencyReplayedFailureError,
  IdempotencyReservationLostError,
  IdempotencyStatusUnknownError,
  IdempotentReplayRedactedError,
  InputInvalidError,
  MutatorNotIdempotentError,
  OutputInvalidError,
  RemoteActionError,
  RpcFailedError,
} from './errors';
export {
  ActionHttpPathInvalidError,
  ActionPathStyleInvalidError,
  OpenApiConfigInvalidError,
} from './errors-http';
export type { OpenApiOperation } from './http';
export {
  operationTagOf,
  REPLAYED_HEADER,
  toOpenApiOperation,
  toPostBinding,
  toRoute,
} from './http';
/** `http: { path }` on an action pins its URL; the app's `pathStyle` derives every other one. */
export type { ActionHttp } from './http-path';
export { actionPathStyle, forgetHandedOutActionPaths } from './http-path';
/**
 * The idempotency seam. `withIdempotency` and `IDEMPOTENCY_HEADER` are both public, so a plain
 * mutating `route` can reserve-and-replay exactly as an action does — `idempotencyKeyFor` is the
 * namespacing it must apply, or two routes sharing a caller's key would share one record, and so
 * would two callers sending one key value.
 */
export type {
  IdempotencyConfig,
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStatus,
  IdempotencyStore,
  IdempotentOutcome,
} from './idempotency';
export {
  assertIdempotencyScope,
  configureIdempotency,
  DEFAULT_IDEMPOTENCY_CONFIG,
  getIdempotencyStore,
  IDEMPOTENCY_STATUSES,
  idempotencyConfig,
  isIdempotencyStatus,
  resetIdempotency,
  setIdempotencyStore,
  withIdempotency,
} from './idempotency';
export { idempotencyKeyFor, MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency-key';
export type {
  MemoryIdempotencyStore,
  MemoryIdempotencyStoreOptions,
} from './idempotency-memory';
export {
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  DEFAULT_MAX_IDEMPOTENCY_KEYS,
  memoryIdempotencyStore,
} from './idempotency-memory';
export type {
  PostgresIdempotencyStore,
  PostgresIdempotencyStoreOptions,
} from './idempotency-postgres';
/** The table's DDL alone: the boot applies it. The store's own statements stay its own. */
export { postgresIdempotencyStore, SQL_IDEMPOTENCY_TABLE } from './idempotency-postgres';
/** The one execution path. `defOf` stays unexported — that is the enforcement. */
export { actionName, invoke } from './invoke';
export type { ActionJobHandle } from './job-handle';
export { toJobHandle } from './job-handle';
export type { JsonSchemaObject } from './json-schema';
export { jsonSchemaOf } from './json-schema';
export type {
  LocalTable,
  LocalTableName,
  LocalTables,
  LocalTx,
  Mutator,
  MutatorDef,
  MutatorDescriptor,
} from './mutator';
export { custom, isMutator, mutator } from './mutator';
export type { ActionPath } from './naming';
export { derivePath, inputSchemaName, outputSchemaName } from './naming';
export type { BuildOpenApiOptions, OpenApiDocument, OpenApiInfo } from './openapi';
export { buildOpenApi, serializeOpenApi } from './openapi';
export {
  BEARER_SCHEME,
  COOKIE_SCHEME,
  completeOpenApi,
  mountOpenApi,
} from './openapi-complete';
/**
 * `@ultimat3/http`'s `hooks.explainMiss` for the action surface: a POST to an action's path under
 * a `pathStyle` this app does not serve answers `X_CONTRACT_DRIFT` naming the style it does.
 */
export { explainActionPathMiss } from './path-style-miss';
export type { ActionPolicy, PolicySubject, Surface } from './policy-gate';
/**
 * The one authz gate, named after what it guards. The display label (`policyCapability`), what a
 * report MATCHES on (`policyPermissions`) and what `toRoute` derives `meta.auth` from
 * (`admitsAnonymous`) are `@ultimat3/policy`'s, and the anonymous → `null` mapping (`actorOf`) is
 * `@ultimat3/core`'s — imported from there, so `query` reads the same walk through one import path.
 */
export { guardAction, guardActionBeforeInput } from './policy-gate';
export {
  actionHttpPath,
  configureActionPathStyle,
  describeActions,
  getAction,
  listActions,
  registerAction,
  registerActions,
  resetActions,
} from './registry';
export { requestDeadlineMs } from './request-deadline';
/**
 * A mutator FACTORY, never a ninth primitive: `transition()` returns a `mutator`, so a move through
 * a state machine inherits the route, the OpenAPI operation, the typed client, the MCP tool, the job
 * handle and its manifest row. The machine itself is `@ultimat3/entity`'s — this package owns the
 * projection, not the legality rule.
 */
export type {
  TransitionDef,
  TransitionInput,
  TransitionTarget,
  TransitionValues,
} from './transition';
export { transition } from './transition';
/**
 * The one reader of a problem document's `issues` member. Exported because the typed client is not
 * the only caller that meets one: an island that posts with a plain `fetch` — which is what
 * `x g resource` emits, to keep this package out of its chunk — holds the parsed body itself and
 * would otherwise write a second, unvalidated reader.
 */
export { issuesFromWire, MAX_WIRE_ISSUES } from './wire-issues';
