/**
 * Public API of @ultimat3/action: the primitive plus its six projections.
 *
 * `handle` is deliberately absent. An action's declaration lives in `invoke.ts`'s
 * private store, and `invoke` is the only thing that reads it — so no adapter can
 * parse, authorize or run on its own. Two authz systems is how every Meteor-like
 * framework died; there is exactly one here, structurally.
 */

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
export type { IdempotencyConflictReason, RemoteFailure } from './errors';
export {
  ActionDeniedError,
  ActionDuplicateError,
  ActionForeignError,
  ActionPolicyMissingError,
  ActionUnregisteredError,
  ContractDriftError,
  IdempotencyConflictError,
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
export type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStore,
  IdempotentOutcome,
} from './idempotency';
export {
  getIdempotencyStore,
  idempotencyKeyFor,
  MemoryIdempotencyStore,
  setIdempotencyStore,
  withIdempotency,
} from './idempotency';
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
export { derivePath, inputSchemaName, outputSchemaName, pluralize, toToolName } from './naming';
export type { BuildOpenApiOptions, OpenApiDocument, OpenApiInfo } from './openapi';
export { buildOpenApi, serializeOpenApi } from './openapi';
export type { ActionPolicy, PolicySubject, Surface } from './policy-gate';
export { actorOf, guard, policyCapability } from './policy-gate';
export {
  describeActions,
  getAction,
  listActions,
  registerAction,
  registerActions,
  resetRegistry,
} from './registry';
