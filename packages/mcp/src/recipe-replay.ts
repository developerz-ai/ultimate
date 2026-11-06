/**
 * `replayRecipes()` — a recipe's contract test: every step's example CALLED through the real server
 * as `caller` (placeholders filled), every `docs://recipes/` link read. No such tool, refused
 * arguments, a refusing policy or a dangling link fail it; a tool's own refusal is the tool working.
 */

import { isJsonObject, renderCauseValue } from '@ultimat3/core';
import { McpRecipeExampleInvalidError, McpRecipeLinkDanglingError } from './recipe-errors';
import { fillPlaceholders } from './recipe-markdown';
import type { McpRecipe } from './recipes';
import { recipeLinks, recipeUri } from './recipes';
import type { McpCaller } from './registry';
import type { McpServer } from './server';

export interface ReplayOptions {
  readonly caller: McpCaller;
  /** `"<postId>"` in an example becomes `placeholders.postId`. */
  readonly placeholders?: Readonly<Record<string, unknown>>;
}

export interface ReplayReport {
  /** `<recipe> step <n> (<tool>)`, one per call made. */
  readonly calls: readonly string[];
  /** Every link read. */
  readonly links: readonly string[];
}

/**
 * The codes that mean the call never reached a tool that took it: no such tool, arguments it
 * refuses, or a caller its policy refuses — a replay as somebody who cannot follow the recipe
 * proves nothing about it. Anything else (`X_NOT_FOUND` for a sample id) is the tool answering.
 */
const UNREACHED = new Set([
  'X_MCP_TOOL_UNKNOWN',
  'X_INPUT_INVALID',
  'X_FORBIDDEN',
  'X_UNAUTHENTICATED',
]);

export async function replayRecipes(
  server: McpServer,
  recipes: readonly McpRecipe[],
  options: ReplayOptions,
): Promise<ReplayReport> {
  const placeholders = new Map(Object.entries(options.placeholders ?? {}));
  const calls: string[] = [];
  const links: string[] = [];
  const failed: string[] = [];
  const dangling: string[] = [];
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    id += 1;
    return server.handle({ jsonrpc: '2.0', id, method, params }, options.caller);
  };
  for (const recipe of recipes) {
    for (const [index, step] of recipe.steps.entries()) {
      if (step.example === undefined) continue;
      const at = `recipe "${recipe.name}" step ${String(index + 1)} (${step.tool})`;
      const args = fillPlaceholders(step.example, placeholders);
      const answer = await rpc('tools/call', { name: step.tool, arguments: args });
      calls.push(at);
      const reason = unreached(answer);
      if (reason !== undefined) failed.push(`${at}: ${reason}`);
    }
    for (const name of recipeLinks(recipe)) {
      const uri = recipeUri(name);
      const answer = await rpc('resources/read', { uri });
      links.push(uri);
      if (answer === null || 'error' in answer) {
        dangling.push(`recipe "${recipe.name}" links to ${uri}`);
      }
    }
  }
  if (failed.length > 0) throw new McpRecipeExampleInvalidError({ offenders: failed });
  if (dangling.length > 0) {
    throw new McpRecipeLinkDanglingError({
      offenders: dangling,
      recipes: recipes.map((recipe) => recipe.name).sort(),
    });
  }
  return { calls, links };
}

/** Why a `tools/call` answer never reached a tool that accepted its arguments, or nothing. */
function unreached(answer: unknown): string | undefined {
  if (!isJsonObject(answer)) return 'no answer';
  const error = answer['error'];
  if (isJsonObject(error)) {
    return `JSON-RPC ${renderCauseValue(error['code'])}: ${renderCauseValue(error['message'])}`;
  }
  const result = answer['result'];
  if (!isJsonObject(result) || result['isError'] !== true) return undefined;
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const text = content
    .map((block: unknown) =>
      isJsonObject(block) && typeof block['text'] === 'string' ? block['text'] : '',
    )
    .join('\n');
  const code = /\b(X_[A-Z0-9_]+)\b/.exec(text)?.[1];
  return code !== undefined && UNREACHED.has(code) ? text.split('\n')[0] : undefined;
}
