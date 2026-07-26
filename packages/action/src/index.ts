/** Public API of @ultimat3/action: the primitive plus its six projections. */

export type {
  Action,
  ActionCache,
  ActionDef,
  ActionDescriptor,
  ActionHandlerArgs,
  ActionMcp,
  ActionRateLimit,
  AnyAction,
  AnyActionDef,
  InvokeOptions,
  McpDescriptorMeta,
} from './action';
export { action, actionName, describeAction, isAction, runAction } from './action';
export type {
  ActionLike,
  ActionMap,
  CallOptions,
  Client,
  ClientMethod,
  ClientOptions,
  FetchLike,
} from './client';
export { createClient } from './client';
export type { ContractTest, ContractTestOptions } from './contract-test';
export { anonymousCtx, contractTestsFor, policyTestStubFor } from './contract-test';
export type { IdempotencyConflictReason } from './errors';
export {
  ActionDeniedError,
  ActionDuplicateError,
  ActionPolicyMissingError,
  ActionUnregisteredError,
  ContractDriftError,
  IdempotencyConflictError,
  InputInvalidError,
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
