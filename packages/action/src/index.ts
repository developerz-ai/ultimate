/**
 * Public API of @ultimat3/action: the primitive plus its six projections.
 *
 * `handle` is deliberately absent. An action's declaration lives in `invoke.ts`'s
 * private store, and `invoke` is the only thing that reads it — so no adapter can
 * parse, authorize or run on its own. Two authz systems is how every Meteor-like
 * framework died; there is exactly one here, structurally.
 */

/**
 * Flight control for the typed client, and OPT-IN by construction: `client.ts` names `ClientFlight`
 * as a TYPE only, so a caller that never mentions `createClientFlight` pays nothing for the fence,
 * the dedup map or the retry loop. Every mechanism underneath is `@ultimat3/core`'s — one fence,
 * one flight map, one gate, one backoff curve for the whole framework — and so is the pipeline
 * itself: it shipped as a byte-identical copy here and in `@ultimat3/query`, and
 * two tier-3 packages may not import each other, so the one copy lives at tier 0.
 *
 * Re-exported rather than re-declared, so every name is importable from this package exactly as
 * before. `isSuperseded` is core's too: reading a fenced answer is the point of installing a
 * flight, and it should not cost a second import.
 */
export type {
  ClientFlight,
  ClientFlightOptions,
  ClientRetry,
  FlightKeyOptions,
  FlightPlan,
  WireAnswer,
} from '@ultimat3/core';
export {
  createClientFlight,
  DEFAULT_CLIENT_RETRY,
  isSuperseded,
  isTransientFailure,
} from '@ultimat3/core';
/**
 * `toBucket` is `@ultimat3/http`'s — http owns `Bucket` and the limiter maths, and `action` and
 * `query` are the same tier, so a copy in either is a second answer for the other. Re-exported
 * here, not re-implemented, so an action file still reaches it through one import.
 */
export { toBucket } from '@ultimat3/http';
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
 * The audit seam. `AuditSink` is the whole extension point: the framework supplies the record
 * and never the row. `audit-gate.ts` stays unexported — the sink has one caller, and that
 * absence is what keeps it one.
 */
export type {
  AuditFailure,
  AuditOutcome,
  AuditRecord,
  AuditSink,
} from './audit';
export { getAuditSink, resetAuditSink, setAuditSink } from './audit';
export { AUDIT_INPUT_MAX_DEPTH, auditableInput, UNREPRESENTABLE } from './audit-input';
export type { MemoryAuditSink, MemoryAuditSinkOptions } from './audit-memory';
export { DEFAULT_MAX_AUDIT_RECORDS, memoryAuditSink } from './audit-memory';
/**
 * The DURABLE sink, and the only one an app that must keep its trail may install. The statements
 * are exported beside it because the table is applied the way `SQL_IDEMPOTENCY_TABLE` is — by the
 * boot, never by an app migration.
 */
export type { PostgresAuditSink, PostgresAuditSinkOptions } from './audit-postgres';
export { postgresAuditSink, SQL_AUDIT_INSERT, SQL_AUDIT_TABLE } from './audit-postgres';
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
/**
 * The compat window a retirement gets. Versioning itself is NOT here and never will be: two
 * versions of one action side by side is two deployments behind one ingress (axiom 7), not a
 * router feature. `renderDeprecation` is exported so a plain `route` can announce the same pair
 * of headers the action projection does.
 */
export type { Deprecation, DeprecationField, DeprecationRender } from './deprecation';
export { recordDeprecatedCall, renderDeprecation } from './deprecation';
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
  IdempotencyStatusUnknownError,
  InputInvalidError,
  OutputInvalidError,
  RemoteActionError,
  RpcFailedError,
} from './errors';
export type { OpenApiOperation } from './http';
export {
  BUILD_ID_HEADER,
  IDEMPOTENCY_HEADER,
  REPLAYED_HEADER,
  toOpenApiOperation,
  toRoute,
} from './http';
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
export type { MemoryIdempotencyStoreOptions } from './idempotency-memory';
export {
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  DEFAULT_MAX_IDEMPOTENCY_KEYS,
  MemoryIdempotencyStore,
} from './idempotency-memory';
/**
 * The SHARED store, and the only one an app running more than one replica may install. The
 * statements are exported beside it because the table is applied the way `SQL_JOBS_TABLE` is —
 * by `x db up` in development and by the release-phase `ROLE=migrate` in production.
 */
export type {
  PgExecutor,
  PostgresIdempotencyStore,
  PostgresIdempotencyStoreOptions,
} from './idempotency-postgres';
export {
  postgresIdempotencyStore,
  SQL_IDEMPOTENCY_FAIL,
  SQL_IDEMPOTENCY_GET,
  SQL_IDEMPOTENCY_PURGE,
  SQL_IDEMPOTENCY_RELEASE,
  SQL_IDEMPOTENCY_RESERVE,
  SQL_IDEMPOTENCY_SETTLE,
  SQL_IDEMPOTENCY_TABLE,
} from './idempotency-postgres';
/** The one execution path. `defOf` stays unexported — that is the enforcement. */
export { actionName, invoke } from './invoke';
export type { ActionJobHandle } from './job-handle';
export { toJobHandle } from './job-handle';
export type { JsonSchemaObject } from './json-schema';
export { jsonSchemaOf, mcpSchemaOf } from './json-schema';
export type { McpInvokeOptions, McpToolDescriptor } from './mcp-tool';
export { isExposed, toMcpTool, toMcpTools } from './mcp-tool';
export type {
  Conflict,
  CustomConflict,
  LocalRow,
  LocalTable,
  LocalTableName,
  LocalTables,
  LocalTx,
  Mutator,
  MutatorDef,
  MutatorDescriptor,
} from './mutator';
export { custom, isMutator, mutator, resolveConflict, strategyOf } from './mutator';
export type { ActionPath } from './naming';
export { derivePath, inputSchemaName, outputSchemaName, pluralize } from './naming';
export type { BuildOpenApiOptions, OpenApiDocument, OpenApiInfo } from './openapi';
export { buildOpenApi, serializeOpenApi } from './openapi';
export type { ActionPolicy, PolicySubject, Surface } from './policy-gate';
/**
 * `policyCapability` is the display label; `policyPermissions` is what a report MATCHES on.
 * `admitsAnonymous` is `@ultimat3/policy`'s, re-exported here beside them: it is what `toRoute`
 * derives `meta.auth` from, so a plain `route` sets that field from the same walk rather than
 * re-reading the root combinator.
 */
export {
  actorOf,
  admitsAnonymous,
  guard,
  policyCapability,
  policyPermissions,
} from './policy-gate';
export {
  describeActions,
  getAction,
  listActions,
  registerAction,
  registerActions,
  resetRegistry,
} from './registry';
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
