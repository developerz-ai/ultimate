// Public API of @ultimat3/mcp. Explicit — nothing is re-exported by wildcard, so the
// surface an app or an agent can reach is exactly this list.

/** `@ultimat3/http`'s `RequestFacts`, under the name this package's resolver docs use. One shape. */
export type { RequestFacts as McpRequestFacts } from '@ultimat3/http';
/** Re-exported so a `defineAppMcp` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { formatIssues, t } from '@ultimat3/schema';
export type {
  AnyAppToolDefinition,
  AppToolArgs,
  AppToolDefinition,
  AppTools,
} from './app-tool';
export type { AppMcp, AppToolSchemas, DefineAppMcpInput } from './app-tools';
export { defineAppMcp } from './app-tools';
export type { McpAuditEntry, McpOutcome, McpResourceAuditEntry } from './audit';
export { auditResourceRead, auditToolCall, outcomeForCode } from './audit';
export type {
  McpAuditEvent,
  McpAuditHook,
  McpAuditor,
  McpAuditorInput,
  McpAuthRefusal,
} from './audit-hook';
export { mcpAuditor } from './audit-hook';
export {
  McpConfirmationArgumentsMismatchError,
  McpConfirmationContestedError,
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationPendingError,
  McpConfirmationRejectedError,
  McpConfirmationToolUnknownError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
export {
  inputDigest,
  MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
  MCP_CONFIRMATION_DIGEST_PURPOSE,
  withConfirmations,
} from './confirmation-gate';
export type { PostgresConfirmationStoreOptions } from './confirmation-postgres';
export { postgresConfirmationStore } from './confirmation-postgres';
export { MCP_CONFIRMATIONS_TABLE, SQL_MCP_CONFIRMATIONS_TABLE } from './confirmation-schema';
export type {
  McpConfirmation,
  McpConfirmationDraft,
  McpConfirmationStatus,
  McpConfirmationStore,
} from './confirmation-store';
export { memoryConfirmationStore } from './confirmation-store';
export type {
  McpConfirmationDecision,
  McpConfirmations,
  McpConfirmationsInput,
} from './confirmations';
export { DEFAULT_MCP_CONFIRMATION_TTL_MS, mcpConfirmations } from './confirmations';
export type { CreateDevServerInput } from './dev-host';
export { createDevServer, devHost, frameworkIntrospection } from './dev-host';
export type {
  DevCapabilities,
  DevHost,
  DevIntrospection,
  ErrorExplanation,
  MigrateResult,
  QueueDepth,
  TestRun,
  UiColorScheme,
  UiDiffInput,
  UiDiffResult,
  UiInspectActive,
  UiInspectBox,
  UiInspectInput,
  UiInspectIslands,
  UiInspectMatch,
  UiInspectResult,
  UiInspectSelector,
  UiInspectSpec,
  UiInteractInput,
  UiInteractInspect,
  UiInteractResult,
  UiInteractStep,
  UiInteractStepKind,
  UiInteractStepResult,
  UiIslandInput,
  UiIslandResult,
  UiScopes,
  UiShotInput,
  UiShotResult,
  UiViewportName,
  VerifyResult,
  VerifyStep,
} from './dev-server';
export {
  DEV_SCOPES,
  devTools,
  UI_INSPECT_LIMITS,
  UI_INTERACT_LIMITS,
} from './dev-server';
export type { McpErrorCode } from './errors';
export {
  MCP_ERROR_CODES,
  MCP_ERROR_TITLES,
  McpAppUnmountedError,
  McpArgsInvalidError,
  McpIdempotencyKeyShadowedError,
  McpNotBranchDbError,
  McpProtocolError,
  McpQueryRejectedError,
  McpResourceDuplicateError,
  McpScopeConflictError,
  McpScopeDeniedError,
  McpScopeUncoveredError,
  McpScopeUnknownError,
  McpSurfaceOverBudgetError,
  McpToolDuplicateError,
  McpToolUndeclaredError,
  McpToolUnknownError,
  McpToolUnsafeError,
} from './errors';
export {
  McpBodyTooLargeError,
  McpOAuthInvalidError,
  McpRateLimitedError,
} from './errors-transport';
export { exposedPrimitives } from './exposed';
export type { McpExposure, ProjectablePrimitive } from './from-action';
export {
  deriveAnnotations,
  isExposed,
  toolFromAction,
  toolFromQuery,
  toolsFrom,
  toolsListed,
} from './from-action';
export { MCP_IDEMPOTENCY_KEY_ARG } from './idempotency-arg';
export type { ListFilterOp, McpListParams } from './list-params';
export { DEFAULT_LIST_MAX_LIMIT, listParamsSchema } from './list-params';
export {
  McpGroupConflictError,
  McpGroupUnknownError,
  McpListParamsInvalidError,
  McpSurfaceInvalidError,
  META_UNKNOWN_FIX,
} from './meta-errors';
export type {
  DescribedAction,
  McpResourceGroup,
  McpResourceGroups,
  McpSurface,
  McpSurfaceOption,
  MetaAction,
  MetaResource,
} from './meta-surface';
export {
  DESCRIBE_RESOURCE,
  LIST_RESOURCES,
  MANAGE_RESOURCE,
  META_TOOL_NAMES,
  oneLineParams,
  renderCatalog,
} from './meta-surface';
export { McpPathDuplicateError } from './mount-errors';
export type { McpOAuth } from './oauth-metadata';
export {
  metadataPaths,
  metadataUrlFor,
  PROTECTED_RESOURCE_WELL_KNOWN,
  protectedResourceMetadata,
} from './oauth-metadata';
export type { ListedPrimitive } from './projectable';
export { asProjectable, toRowsOutputSchema } from './projectable';
export type { QueryLimits, QueryResult, QueryRows } from './query-limits';
export {
  capQueryRows,
  resolveQueryLimits,
} from './query-limits';
export type { DatabaseTarget } from './readonly-sql';
export { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';
export type {
  AnyMcpTool,
  ContentBlock,
  McpCaller,
  McpRole,
  McpTool,
  McpToolAnnotations,
  McpToolResult,
  McpVerbClass,
  McpVisibility,
  ToolArgs,
  ToolListEntry,
  ToolResolution,
} from './registry';
export {
  jsonResult,
  structuredResult,
  ToolRegistry,
  textResult,
  toolListEntry,
  visibleToCaller,
} from './registry';
export type {
  FrameworkResourceProviders,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  ResourceContents,
  ResourceListEntry,
  ResourceResolution,
} from './resources';
export {
  frameworkResources,
  promptFromPath,
  RESOURCE_URIS,
  ResourceRegistry,
  toPrompts,
} from './resources';
export type { McpScopes } from './scopes';
export { withScopes } from './scopes';
export type { CreateMcpServerInput, McpWire } from './server';
export { createMcpServer, McpServer } from './server';
export type { McpInstructions, McpServerVoice } from './server-voice';
export type { McpSurfaceBudget, McpSurfaceSize } from './surface-budget';
export { assertMcpSurfaceBudget, measureMcpSurface } from './surface-budget';
export type {
  McpHttpTransportInput,
  McpProtectedResource,
  McpRateLimits,
  McpRequestOrigin,
  McpRouteDescriptor,
  ResolvedToken,
} from './transport-http';
export {
  DEFAULT_MCP_BODY_LIMIT_BYTES,
  MCP_RATE_LIMITS,
  MCP_UNAUTHENTICATED_LIMIT,
  mcpHttpRoute,
} from './transport-http';
export type { StdioTransportInput } from './transport-stdio';
export { serveStdio } from './transport-stdio';
export type { ArgIssue, ArgValidation } from './validate-args';
export { validateArgs } from './validate-args';
export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonSchema,
  ServerInfo,
} from './wire';
export {
  defaultServerInfo,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  resultResponse,
} from './wire';
