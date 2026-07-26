// Public API of @ultimat3/mcp. Explicit — nothing is re-exported by wildcard, so the
// surface an app or an agent can reach is exactly this list.

export type { AppMcp, DefineAppMcpInput } from './app-tools.ts';
export { defineAppMcp } from './app-tools.ts';
export type { CreateDevServerInput } from './dev-host.ts';
export { createDevServer, devHost, frameworkIntrospection } from './dev-host.ts';
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
} from './dev-server.ts';
export { DEV_SCOPES, devTools } from './dev-server.ts';
export type { McpErrorCode } from './errors.ts';
export {
  MCP_ERROR_CODES,
  McpArgsInvalidError,
  McpProtocolError,
  McpReadOnlyViolationError,
  McpScopeMissingError,
  McpToolUnknownError,
} from './errors.ts';
export type { McpExposure, ProjectablePrimitive } from './from-action.ts';
export { isExposed, toolFromAction, toolFromQuery, toolsFrom } from './from-action.ts';
export type { DatabaseTarget } from './readonly-sql.ts';
export { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql.ts';
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
} from './registry.ts';
export { jsonResult, ToolRegistry, textResult, visibleToCaller } from './registry.ts';
export type {
  FrameworkResourceProviders,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  ResourceContents,
  ResourceListEntry,
} from './resources.ts';
export {
  frameworkResources,
  RESOURCE_URIS,
  ResourceRegistry,
  URI_ARG_SCHEMA,
} from './resources.ts';
export type { CreateMcpServerInput } from './server.ts';
export { createMcpServer, McpServer } from './server.ts';
export type {
  McpHttpTransportInput,
  McpRouteDescriptor,
  ResolvedToken,
} from './transport-http.ts';
export { bearerToken, isAgentActor, MCP_RATE_LIMITS, mcpHttpRoute } from './transport-http.ts';
export type { StdioTransportInput } from './transport-stdio.ts';
export { serveStdio } from './transport-stdio.ts';
export type { ArgIssue, ArgValidation } from './validate-args.ts';
export { formatIssues, validateArgs } from './validate-args.ts';
export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonSchema,
  ServerInfo,
} from './wire.ts';
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
} from './wire.ts';
