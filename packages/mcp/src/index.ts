// Public API of @ultimat3/mcp. Explicit — nothing is re-exported by wildcard, so the
// surface an app or an agent can reach is exactly this list.

/** `@ultimat3/http`'s `RequestFacts`, under the name this package's resolver docs use. One shape. */
export type { RequestFacts as McpRequestFacts } from '@ultimat3/http';
/** Re-exported so a `defineAppMcp` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { McpCatalog, McpRuntimeCatalog } from './app-catalog';
export type { AnyAppToolDefinition, AppToolArgs, AppToolDefinition, AppTools } from './app-tool';
export type { AppMcp, AppToolSchemas, DefineAppMcpInput } from './app-tools';
export { defineAppMcp } from './app-tools';
export type { McpAuditEntry, McpOutcome, McpResourceAuditEntry } from './audit';
export { auditResourceRead } from './audit';
export type { McpAuditEvent, McpAuditHook, McpAuditor, McpAuthRefusal } from './audit-hook';
export {
  McpTenantInvalidError,
  McpTenantRequiredError,
  McpTenantUnresolvedError,
} from './catalog-errors';
export type {
  McpApproverSelector,
  McpApproversCall,
  McpApproversResolver,
  McpConfirmationApprovers,
} from './confirmation-approvers';
export {
  McpConfirmationArgumentsMismatchError,
  McpConfirmationDecidedError,
  McpConfirmationExpiredError,
  McpConfirmationPendingError,
  McpConfirmationRejectedError,
  McpConfirmationToolUnknownError,
  McpConfirmationUnknownError,
} from './confirmation-errors';
export type {
  McpConfirmationEvidence,
  McpConfirmationVerdict,
  McpEvidenceCheck,
  VerifyConfirmationOptions,
} from './confirmation-evidence';
export { verifyConfirmationEvidence } from './confirmation-evidence';
export { inputDigest } from './confirmation-gate';
export type { PostgresConfirmationStoreOptions } from './confirmation-postgres';
export { postgresConfirmationStore } from './confirmation-postgres';
export type { McpEvidenceFailure } from './confirmation-quorum-errors';
export {
  McpConfirmationEvidenceInvalidError,
  McpConfirmationQuorumInvalidError,
  McpConfirmationQuorumPendingError,
} from './confirmation-quorum-errors';
// The confirmation table's DDL is `@ultimat3/mcp/schema`'s alone — one import path for one statement.
export type {
  McpConfirmation,
  McpConfirmationApproval,
  McpConfirmationDraft,
  McpConfirmationStatus,
  McpConfirmationStore,
} from './confirmation-store';
export { memoryConfirmationStore } from './confirmation-store';
export type { McpConfirmations, McpConfirmationsInput } from './confirmations';
export { mcpConfirmations } from './confirmations';
export type { DevGraphHost, DevGraphQuestion } from './dev-graph-tool';
export type { DevMcpServerInput } from './dev-host';
export { devHost, devMcpServer, frameworkIntrospection } from './dev-host';
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
  UiInteractStepKind,
  UiInteractStepResult,
  UiIslandInput,
  UiIslandResult,
  UiShotInput,
  UiShotResult,
  VerifyResult,
  VerifyStep,
} from './dev-server';
export { DEV_SCOPES, devTools, UI_INSPECT_LIMITS, UI_INTERACT_LIMITS } from './dev-server';
export type { McpErrorCode } from './errors';
export {
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
export type { McpMirroredHeader } from './errors-transport';
export {
  McpBodyTooLargeError,
  McpHeaderMismatchError,
  McpHostRefusedError,
  McpOriginRefusedError,
  McpProtocolUnsupportedError,
  McpRateLimitedError,
} from './errors-transport';
export { exposedPrimitives } from './exposed';
export type { ProjectablePrimitive } from './from-action';
export { deriveAnnotations, toolFrom, toolsFrom, toolsListed } from './from-action';
export { MCP_IDEMPOTENCY_KEY_ARG } from './idempotency-arg';
export { assertIncludeCurrent } from './include-early';
export type { JobToolAnswer, JobToolDef, JobToolWait } from './job-tool';
export { JOB_TOOL_INLINE_CEILING_MS, jobTool } from './job-tool';
export type { ListFilterOp, McpListParams } from './list-params';
export { DEFAULT_LIST_MAX_LIMIT, listParamsSchema } from './list-params';
export type { McpCatalogDetail } from './meta-catalog-render';
export { oneLineParams, renderCatalog } from './meta-catalog-render';
export {
  McpGroupConflictError,
  McpGroupUnknownError,
  McpListParamsInvalidError,
  McpSurfaceInvalidError,
} from './meta-errors';
export type { McpEffectClass } from './meta-split';
export type {
  McpResourceGroup,
  McpResourceGroups,
  McpSurface,
  McpSurfaceOption,
  MetaAction,
  MetaResource,
} from './meta-surface';
export { McpPathDuplicateError } from './mount-errors';
export type { McpOAuth } from './oauth-metadata';
export { PROTECTED_RESOURCE_WELL_KNOWN } from './oauth-metadata';
export type { McpAuthorizationServer, McpAuthorizationServerOptions } from './oauth-server';
export { mcpAuthorizationServer } from './oauth-server';
export type { ListedPrimitive } from './projectable';
export { asProjectable, toRowsOutputSchema } from './projectable';
export type { QueryLimits, QueryResult, QueryRows } from './query-limits';
export { capQueryRows, resolveQueryLimits } from './query-limits';
export type { DatabaseTarget } from './readonly-sql';
export { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';
export { assertRecipeLinks, servedRecipes } from './recipe-links';
export { markdownRecipes } from './recipe-markdown';
export type { ReplayOptions, ReplayReport } from './recipe-replay';
export { replayRecipes } from './recipe-replay';
export type { McpRecipe, McpRecipeStep } from './recipes';
export type { ExtraRecipes } from './recipes-tool';
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
export type { McpClient, McpClientOptions, RemoteTool, RemoteToolResult } from './remote-client';
export { mcpClient } from './remote-client';
export type { McpRemoteFailure } from './remote-errors';
export {
  McpRemoteAuthRequiredError,
  McpRemoteRefusedError,
  McpRemoteToolChangedError,
} from './remote-errors';
export type { LockedServer, LockedTool } from './remote-lock';
export {
  assertLocked,
  lockChanges,
  readToolsLock,
  TOOLS_LOCK_FILE,
  writeToolsLock,
} from './remote-lock';
export type {
  McpOAuthClient,
  McpOAuthClientOptions,
  McpOAuthHandshake,
  McpOAuthStart,
  McpOAuthTokens,
} from './remote-oauth';
export { mcpOAuthClient } from './remote-oauth';
export type { DeclaredMcpServer, McpTools, McpToolsDef, RemoteToolAction } from './remote-tools';
export { declaredMcpServers, mcpTools } from './remote-tools';
export type {
  FrameworkResourceProviders,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  McpResourceSource,
  ResourceContents,
  ResourceListEntry,
  ResourceResolution,
} from './resources';
export { frameworkResources, ResourceRegistry } from './resources';
export type { McpRuntimeTool, RuntimeToolArgs, RuntimeToolDefinition } from './runtime-tool';
export { runtimeTool } from './runtime-tool';
export type { McpScopes } from './scopes';
export { withScopes } from './scopes';
export type { McpServer, McpServerInput, McpWire } from './server';
export { mcpServer } from './server';
export type { McpCatalogSource, McpResolvedCatalog } from './server-catalog';
export type { McpInstructions, McpServerVoice } from './server-voice';
export type { McpSurfaceBudget, McpSurfaceSize } from './surface-budget';
export { assertMcpSurfaceBudget, measureMcpSurface } from './surface-budget';
export type { McpTenant, McpTenantEntry } from './tenant';
export type {
  McpHttpTransportInput,
  McpProtectedResource,
  McpRateLimits,
  McpRequestOrigin,
  McpRouteDescriptor,
  ResolvedToken,
} from './transport-http';
export { MCP_RATE_LIMITS, MCP_UNAUTHENTICATED_LIMIT, mcpHttpRoute } from './transport-http';
export { mcpHostRefused } from './transport-http-answers';
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
  HEADER_MISMATCH,
  INTERNAL_ERROR,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './wire';
