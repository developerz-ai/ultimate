// Public API of @ultimat3/mcp. Explicit — nothing is re-exported by wildcard, so the
// surface an app or an agent can reach is exactly this list.

export type {
  AnyAppToolDefinition,
  AppToolArgs,
  AppToolDefinition,
  AppTools,
} from './app-tool';
export { appToolPrimitive, appToolPrimitives } from './app-tool';
export type { AppMcp, AppToolSchemas, DefineAppMcpInput } from './app-tools';
export { defineAppMcp } from './app-tools';
export type { CreateDevServerInput } from './dev-host';
export { createDevServer, devHost, frameworkIntrospection } from './dev-host';
export type {
  DevCapabilities,
  DevHost,
  DevIntrospection,
  ErrorExplanation,
  MigrateResult,
  QueryResult,
  QueueDepth,
  TestRun,
  VerifyResult,
  VerifyStep,
} from './dev-server';
export { DEV_SCOPES, devTools } from './dev-server';
export type { McpErrorCode } from './errors';
export {
  MCP_ERROR_CODES,
  McpArgsInvalidError,
  McpProtocolError,
  McpReadOnlyViolationError,
  McpScopeMissingError,
  McpToolUnknownError,
  McpToolUnsafeError,
} from './errors';
export { exposedPrimitives } from './exposed';
export type { McpExposure, ProjectablePrimitive } from './from-action';
export { isExposed, toolFromAction, toolFromQuery, toolsFrom } from './from-action';
export { toWireSchema } from './input-schema';
export type { DatabaseTarget } from './readonly-sql';
export { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';
export type {
  AnyMcpTool,
  ContentBlock,
  McpCaller,
  McpRole,
  McpTool,
  McpToolResult,
  McpVerbClass,
  ToolArgs,
  ToolListEntry,
  ToolResolution,
} from './registry';
export { jsonResult, ToolRegistry, textResult, visibleToCaller } from './registry';
export type {
  FrameworkResourceProviders,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  ResourceContents,
  ResourceListEntry,
} from './resources';
export {
  frameworkResources,
  promptFromPath,
  RESOURCE_URIS,
  ResourceRegistry,
  toPrompts,
  URI_ARG_SCHEMA,
} from './resources';
export type { CreateMcpServerInput } from './server';
export { createMcpServer, McpServer } from './server';
export type {
  McpHttpTransportInput,
  McpRouteDescriptor,
  ResolvedToken,
} from './transport-http';
export { bearerToken, isAgentActor, MCP_RATE_LIMITS, mcpHttpRoute } from './transport-http';
export type { StdioTransportInput } from './transport-stdio';
export { serveStdio } from './transport-stdio';
export type { ArgIssue, ArgValidation } from './validate-args';
export { formatIssues, validateArgs } from './validate-args';
export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonSchema,
  ServerInfo,
} from './wire';
export {
  DEFAULT_SERVER_INFO,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  NO_ARGS,
  PARSE_ERROR,
  resultResponse,
} from './wire';
