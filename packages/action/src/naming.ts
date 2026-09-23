/**
 * The one naming rule: an action's export name derives its HTTP path and its
 * OpenAPI component names. Pure string math so the browser client can derive
 * the same path without importing a byte of server code. The MCP tool name is
 * derived by nothing — it is the export name verbatim.
 */

import type { ActionRoute } from '@ultimat3/core';
import { actionRoute, splitWords } from '@ultimat3/core';

/**
 * The path rule is `@ultimat3/core`'s `client-paths.ts` — the typed client, the route and the
 * spec derive one URL from one function. Re-exported by name so `@ultimat3/action`'s public
 * `derivePath` / `pluralize` / `splitWords` / `ActionPath` keep resolving; never re-declared here.
 */
export { pluralize, splitWords } from '@ultimat3/core';

export type ActionPath = ActionRoute;

/**
 * `publishPost`        -> POST /api/posts/publish
 * `updateUserProfile`  -> POST /api/user-profiles/update
 * `checkout`           -> POST /api/checkouts/invoke   (single-word fallback)
 */
export function derivePath(name: string): ActionPath {
  return actionRoute(name);
}

// There is deliberately no `toToolName`. An MCP tool name is the export name verbatim — the one
// `@ultimat3/mcp` serves and the one a `tools/call` spells — so a second derivation would be a
// second name for one action, which is what shipped `publish_post` in two committed contracts.

/** OpenAPI `operationId` is the action name verbatim — it is already unique. */
export function toOperationId(name: string): string {
  return name;
}

const pascal = (name: string): string =>
  splitWords(name)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join('');

/** OpenAPI component name for an action's input schema. */
export function inputSchemaName(name: string): string {
  return `${pascal(name)}Input`;
}

/** OpenAPI component name for an action's output schema. */
export function outputSchemaName(name: string): string {
  return `${pascal(name)}Output`;
}

/** RFC 9457 body shared by every error response. */
export const PROBLEM_SCHEMA_NAME = 'Problem';

export function schemaRef(component: string): string {
  return `#/components/schemas/${component}`;
}
