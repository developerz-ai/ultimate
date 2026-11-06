/**
 * What `recipes:` and `extraRecipes:` add to a `defineAppMcp` server, after the boot checks: the
 * `docs` tool, one `docs://recipes/<name>` resource per recipe, and — for a caller's own — a
 * per-caller resource source. Nothing at all without either option.
 */

import { McpToolDuplicateError } from './errors';
import { noteServedRecipes } from './recipe-links';
import type { McpRecipe } from './recipes';
import { assertNoRecipeResources, checkRecipes, recipeResources } from './recipes';
import type { ExtraRecipes } from './recipes-tool';
import { DOCS_TOOL, recipesFor, recipesTool } from './recipes-tool';
import type { AnyMcpTool } from './registry';
import type { McpResource, McpResourceSource } from './resources';

export interface RecipeSurface {
  readonly tools: readonly AnyMcpTool[];
  readonly resources: readonly McpResource[];
  readonly resourceSources: readonly McpResourceSource[];
}

export function withRecipes(
  tools: readonly AnyMcpTool[],
  resources: readonly McpResource[],
  recipes: readonly McpRecipe[] | undefined,
  extra: ExtraRecipes | undefined,
): RecipeSurface {
  const declared = recipes ?? [];
  if (declared.length === 0 && extra === undefined) {
    return { tools, resources, resourceSources: [] };
  }
  assertNoRecipeResources(resources);
  checkRecipes(declared, tools);
  // The one name this adds; an app tool already called `docs` is a duplicate, never a shadow.
  if (tools.some((tool) => tool.name === DOCS_TOOL)) {
    throw new McpToolDuplicateError({ name: DOCS_TOOL, declaredBy: ['tools:', 'recipes:'] });
  }
  const final: readonly AnyMcpTool[] = [...tools, recipesTool(declared, () => final, extra)];
  noteServedRecipes(declared.map((recipe) => recipe.name));
  const source: McpResourceSource | undefined =
    extra === undefined
      ? undefined
      : {
          list: async (caller) =>
            recipeResources(
              (await recipesFor([], extra, final, caller)).map((entry) => entry.recipe),
              final,
            ),
        };
  return {
    tools: final,
    resources: [...resources, ...recipeResources(declared, final)],
    resourceSources: source === undefined ? [] : [source],
  };
}
