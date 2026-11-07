// Public API of @ultimat3/mcp. Explicit — nothing is re-exported by wildcard, so the
// surface an app or an agent can reach is exactly this list.

/** `@ultimat3/http`'s `RequestFacts`, under the name this package's resolver docs use. One shape. */
export type { RequestFacts as McpRequestFacts } from '@ultimat3/http';
/** Re-exported so a `defineAppMcp` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type { McpCatalog, McpRuntimeCatalog } from './app-catalog';
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
export type { McpCatalogNameSource } from './catalog-errors';
export {
  McpCatalogToolDuplicateError,
  McpCatalogUnresolvedError,
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
  McpConfirmationContestedError,
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
export {
  confirmationSigningPayload,
  MCP_CONFIRMATION_SIGNING_PURPOSE,
  verifyConfirmationEvidence,
} from './confirmation-evidence';
export {
  inputDigest,
  MCP_CONFIRMATION_ARGUMENTS_PURPOSE,
  MCP_CONFIRMATION_DIGEST_PURPOSE,
  withConfirmations,
} from './confirmation-gate';
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
export type {
  McpConfirmationDecision,
  McpConfirmations,
  McpConfirmationsInput,
} from './confirmations';
export { DEFAULT_MCP_CONFIRMATION_TTL_MS, mcpConfirmations } from './confirmations';
export type { DevGraphHost, DevGraphQuestion } from './dev-graph-tool';
export { graphQuestion } from './dev-graph-tool';
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
export type { McpMirroredHeader } from './errors-transport';
export {
  McpBodyTooLargeError,
  McpHeaderMismatchError,
  McpHostRefusedError,
  McpOAuthInvalidError,
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
export { JOB_STATUS_TOOL, JOB_TOOL_INLINE_CEILING_MS, jobTool } from './job-tool';
export { McpJobToolInvalidError } from './job-tool-errors';
export type { ListFilterOp, McpListParams } from './list-params';
export { DEFAULT_LIST_MAX_LIMIT, listParamsSchema } from './list-params';
export {
  McpEffectConflictError,
  McpEffectUndeclaredError,
  McpGroupConflictError,
  McpGroupUnknownError,
  McpListParamsInvalidError,
  McpSurfaceInvalidError,
  McpUserConfirmationRequiredError,
  McpWrongToolError,
  META_UNKNOWN_FIX,
} from './meta-errors';
export type { McpEffectClass } from './meta-split';
export {
  DELETE_RESOURCE,
  effectOf,
  READ_RESOURCE,
  SPLIT_DISPATCHERS,
  toolForEffect,
  WRITE_RESOURCE,
} from './meta-split';
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
export { McpIncludeEarlyError, McpPathDuplicateError } from './mount-errors';
export type { McpOAuth } from './oauth-metadata';
export {
  metadataPaths,
  metadataUrlFor,
  PROTECTED_RESOURCE_WELL_KNOWN,
  protectedResourceMetadata,
} from './oauth-metadata';
export type { McpAuthorizationServer, McpAuthorizationServerOptions } from './oauth-server';
export { mcpAuthorizationServer } from './oauth-server';
export type { ListedPrimitive } from './projectable';
export { asProjectable, toRowsOutputSchema } from './projectable';
export type { QueryLimits, QueryResult, QueryRows } from './query-limits';
export {
  capQueryRows,
  resolveQueryLimits,
} from './query-limits';
export type { DatabaseTarget } from './readonly-sql';
export { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';
export {
  McpRecipeExampleInvalidError,
  McpRecipeLinkDanglingError,
  McpRecipeToolUnknownError,
  McpRecipeUnknownError,
  McpRecipeUriReservedError,
} from './recipe-errors';
export { assertRecipeLinks, servedRecipes } from './recipe-links';
export { markdownRecipes, recipeFromMarkdown } from './recipe-markdown';
export type { ReplayOptions, ReplayReport } from './recipe-replay';
export { replayRecipes } from './recipe-replay';
export type { McpRecipe, McpRecipeStep } from './recipes';
export { RECIPE_URI_PREFIX, recipeUri, renderRecipe } from './recipes';
export type { ExtraRecipes } from './recipes-tool';
export { DOCS_TOOL } from './recipes-tool';
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
  McpClient,
  McpClientOptions,
  RemoteTool,
  RemoteToolResult,
} from './remote-client';
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
export { declaredMcpServers, mcpTools, RemoteToolOutput } from './remote-tools';
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
export {
  frameworkResources,
  promptFromPath,
  RESOURCE_URIS,
  ResourceRegistry,
  toPrompts,
} from './resources';
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
export { LIST_TENANTS } from './tenant';
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
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  resultResponse,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './wire';
