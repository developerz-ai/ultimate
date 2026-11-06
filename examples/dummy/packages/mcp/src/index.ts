/** The public surface of @postly/mcp. Explicit — never `export *`. */

/**
 * The factory `apps/web` declares its long tools with: the app's MCP package is the one door its
 * app reaches the MCP surface through, so the app imports no second MCP package for one call.
 */
export { jobTool } from '@ultimat3/mcp';
export { confirmAgentPublish, confirmationStore } from './confirmations';
export type { PostlyMcpApp } from './tools';
export { POSTLY_RECIPES, postlyMcp } from './tools';
