/**
 * `docs` — recipes for clients that ignore resources: `{}` lists, `{ name }` / `{ uri }` reads one,
 * `{ q }` inlines the best match or names the nearest. Gated per recipe by the tools it names, so
 * hidden and unknown are one not-found; a caller's own recipes are marked `source: 'caller'`.
 */

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import { rankRecipes } from './recipe-search';
import type { McpRecipe } from './recipes';
import { recipeNameOf, recipeUri, recipeVisible, renderRecipe } from './recipes';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';

export const DOCS_TOOL = 'docs';

/** A caller's own recipes, asked per call — a tenant's runbooks beside the app's. */
export type ExtraRecipes = (
  caller: McpCaller,
) => Promise<readonly McpRecipe[]> | readonly McpRecipe[];

/** One recipe this caller may follow, and where it came from. */
export interface SourcedRecipe {
  readonly recipe: McpRecipe;
  readonly source: 'app' | 'caller';
}

/** The app's recipes, then the caller's (a name the app holds is never shadowed), all gated. */
export async function recipesFor(
  recipes: readonly McpRecipe[],
  extra: ExtraRecipes | undefined,
  catalog: readonly AnyMcpTool[],
  caller: McpCaller,
): Promise<readonly SourcedRecipe[]> {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const taken = new Set(recipes.map((recipe) => recipe.name));
  const own = extra === undefined ? [] : await extra(caller);
  return [
    ...recipes.map((recipe) => ({ recipe, source: 'app' as const })),
    ...own
      .filter((recipe) => !taken.has(recipe.name))
      .map((recipe) => ({ recipe, source: 'caller' as const })),
  ].filter((entry) => recipeVisible(entry.recipe, tools, caller));
}

export function recipesTool(
  recipes: readonly McpRecipe[],
  catalog: () => readonly AnyMcpTool[],
  extra?: ExtraRecipes,
): AnyMcpTool {
  return {
    name: DOCS_TOOL,
    description:
      'How-to recipes for this server. docs({}) lists the ones you can follow; docs({ q }) finds one by words and reads it; docs({ name }) or docs({ uri }) reads one: which tools to call, in order, with example arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A recipe name from docs({}).' },
        uri: { type: 'string', description: 'A docs://recipes/ URI, as an error links one.' },
        q: { type: 'string', description: 'Words describing the task.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    destructive: false,
    async handle(args, caller: McpCaller): Promise<McpToolResult> {
      const visible = await recipesFor(recipes, extra, catalog(), caller);
      const named =
        typeof args['name'] === 'string'
          ? args['name']
          : typeof args['uri'] === 'string'
            ? (recipeNameOf(args['uri']) ?? args['uri'])
            : undefined;
      if (named !== undefined) {
        const found = visible.find((entry) => entry.recipe.name === named);
        if (found === undefined) throw notFound(named);
        return text(renderRecipe(found.recipe));
      }
      if (typeof args['q'] === 'string' && args['q'].trim() !== '') {
        return text(answerQuery(visible, args['q']));
      }
      return text(JSON.stringify({ recipes: visible.map(row) }));
    },
  };
}

const row = (entry: SourcedRecipe) => ({
  name: entry.recipe.name,
  title: entry.recipe.title,
  description: entry.recipe.description,
  uri: recipeUri(entry.recipe.name),
  source: entry.source,
});

/** The best match inlined, with the runners-up named; a miss names the nearest instead. */
function answerQuery(visible: readonly SourcedRecipe[], q: string): string {
  const sources = new Map(visible.map((entry) => [entry.recipe.name, entry.source]));
  const { matches, nearest } = rankRecipes(
    visible.map((entry) => entry.recipe),
    q,
  );
  const line = (recipe: McpRecipe) =>
    `- docs({ name: '${recipe.name}' }) — ${recipe.title}${sources.get(recipe.name) === 'caller' ? ' (yours)' : ''}`;
  const [best, ...rest] = matches;
  if (best !== undefined) {
    const related = rest.slice(0, 4);
    return related.length === 0
      ? renderRecipe(best)
      : `${renderRecipe(best)}\n---\nAlso matching:\n${related.map(line).join('\n')}\n`;
  }
  if (nearest.length === 0) return 'No recipes are available to this caller.\n';
  return `No recipe matches ${JSON.stringify(q)}. Nearest:\n${nearest.map(line).join('\n')}\n`;
}

const text = (body: string): McpToolResult => ({ content: [{ type: 'text', text: body }] });

/** One answer for hidden and unknown, so a name cannot be probed into existence. */
function notFound(name: string): UltimateError {
  return new UltimateError({
    code: 'X_MCP_TOOL_UNKNOWN',
    cause: `no recipe named ${renderCauseValue(name)} for this caller`,
    fix: 'docs({})   # lists the recipes this caller can follow',
    callerFix: 'docs({})   # lists the recipes this caller can follow',
  });
}
