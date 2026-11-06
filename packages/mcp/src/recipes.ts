/**
 * MCP recipes — "how do I do X here" as structure the boot checks: every step names a projected
 * tool and its example must pass that tool's input. Served as `docs://recipes/<name>` and through
 * `docs`, only to a caller who can see and call every tool a recipe names.
 */

import {
  McpRecipeExampleInvalidError,
  McpRecipeLinkDanglingError,
  McpRecipeToolUnknownError,
  McpRecipeUriReservedError,
} from './recipe-errors';
import { placeholderPaths } from './recipe-markdown';
import type { AnyMcpTool, McpCaller } from './registry';
import { visibleToCaller } from './registry';
import type { McpResource } from './resources';
import { validateArgs } from './validate-args';

export const RECIPE_URI_PREFIX = 'docs://recipes/';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface McpRecipeStep {
  /** A tool THIS server projects, by name. Checked at boot. */
  readonly tool: string;
  /** Why this step, in the reader's words. */
  readonly why: string;
  /** Arguments for the tool, checked against its input schema at boot. */
  readonly example?: Readonly<Record<string, unknown>>;
}

export interface McpRecipe {
  /** `[a-z0-9-]+`; the URI is `docs://recipes/<name>`. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly McpRecipeStep[];
  /** Free text, unchecked: where a tool is named, it is a step. */
  readonly notes?: string;
  /**
   * Markdown served VERBATIM in place of the rendered steps — what `markdownRecipes({ dir })`
   * builds from a file, its ```call fences becoming `steps`, so they are checked all the same.
   */
  readonly body?: string;
}

export const recipeUri = (name: string): string => `${RECIPE_URI_PREFIX}${name}`;

/** The recipe a `docs://recipes/<name>` names, or `undefined` for any other URI. */
export const recipeNameOf = (uri: string): string | undefined =>
  uri.startsWith(RECIPE_URI_PREFIX) ? uri.slice(RECIPE_URI_PREFIX.length) : undefined;

/**
 * Every boot refusal at once: names, then unknown tools, then examples — each kind collects all
 * offenders, so one boot names every stale recipe. `catalog` is the FINAL projected tool list.
 */
export function checkRecipes(recipes: readonly McpRecipe[], catalog: readonly AnyMcpTool[]): void {
  const seen = new Set<string>();
  for (const recipe of recipes) {
    const uri = recipeUri(recipe.name);
    if (!NAME.test(recipe.name)) throw new McpRecipeUriReservedError({ uri, reason: 'name' });
    if (seen.has(recipe.name)) throw new McpRecipeUriReservedError({ uri, reason: 'duplicate' });
    seen.add(recipe.name);
  }
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const unknown: string[] = [];
  const invalid: string[] = [];
  for (const recipe of recipes) {
    recipe.steps.forEach((step, index) => {
      const tool = tools.get(step.tool);
      const at = `recipe "${recipe.name}" step ${String(index + 1)}`;
      if (tool === undefined) {
        unknown.push(`${at} names "${step.tool}"`);
        return;
      }
      if (step.example === undefined) return;
      const checked = validateArgs(tool.inputSchema, step.example);
      // A whole `"<name>"` value stands for any value of its field: `replay` fills it.
      const open = new Set(placeholderPaths(step.example));
      const issues = checked.ok ? [] : checked.issues.filter((issue) => !open.has(issue.path));
      if (issues.length > 0) {
        const lines = issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`);
        invalid.push(`${at} (${step.tool}): ${lines.join(', ')}`);
      }
    });
  }
  if (unknown.length > 0) {
    throw new McpRecipeToolUnknownError({ offenders: unknown, catalog: [...tools.keys()].sort() });
  }
  if (invalid.length > 0) throw new McpRecipeExampleInvalidError({ offenders: invalid });
  assertRecipeBodyLinks(recipes);
}

/** Every `docs://recipes/<name>` a recipe's text names, as written. */
export function recipeLinks(recipe: McpRecipe): readonly string[] {
  const text = `${recipe.body ?? ''}\n${recipe.notes ?? ''}`;
  return [...text.matchAll(/docs:\/\/recipes\/([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map(
    (match) => match[1] as string,
  );
}

/** A recipe pointing at one that does not exist is the stale link this whole file refuses. */
function assertRecipeBodyLinks(recipes: readonly McpRecipe[]): void {
  const names = new Set(recipes.map((recipe) => recipe.name));
  const offenders = recipes.flatMap((recipe) =>
    recipeLinks(recipe)
      .filter((name) => !names.has(name))
      .map((name) => `recipe "${recipe.name}" links to ${recipeUri(name)}`),
  );
  if (offenders.length > 0) {
    throw new McpRecipeLinkDanglingError({ offenders, recipes: [...names].sort() });
  }
}

/** A hand-written resource may not take the prefix `recipes:` owns on the same server. */
export function assertNoRecipeResources(resources: readonly McpResource[]): void {
  const taken = resources.find((resource) => resource.uri.startsWith(RECIPE_URI_PREFIX));
  if (taken !== undefined)
    throw new McpRecipeUriReservedError({ uri: taken.uri, reason: 'resource' });
}

/**
 * Visible only when every step's tool is visible to this caller AND its scope is on the token —
 * a staff workflow stays off a customer's list, and hidden reads exactly as unknown.
 */
export function recipeVisible(
  recipe: McpRecipe,
  tools: ReadonlyMap<string, AnyMcpTool>,
  caller: McpCaller,
): boolean {
  return recipe.steps.every((step) => {
    const tool = tools.get(step.tool);
    if (tool === undefined || !visibleToCaller(tool, caller)) return false;
    return tool.scope === undefined || caller.scopes.has(tool.scope);
  });
}

/** Markdown, from the structure alone: the same recipe is the same bytes. */
export function renderRecipe(recipe: McpRecipe): string {
  if (recipe.body !== undefined) return recipe.body;
  const lines = [`# ${recipe.title}`, '', recipe.description, '', '## Steps', ''];
  recipe.steps.forEach((step, index) => {
    lines.push(`${String(index + 1)}. \`${step.tool}\` — ${step.why}`);
    if (step.example !== undefined) {
      lines.push('', '   ```json', `   ${JSON.stringify(step.example)}`, '   ```', '');
    }
  });
  if (recipe.notes !== undefined && recipe.notes.trim() !== '') {
    lines.push('', '## Notes', '', recipe.notes.trim());
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Each recipe as an `McpResource`, gated per caller by the tools it names. */
export function recipeResources(
  recipes: readonly McpRecipe[],
  catalog: readonly AnyMcpTool[],
): readonly McpResource[] {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  return recipes.map((recipe) => ({
    uri: recipeUri(recipe.name),
    name: recipe.title,
    description: recipe.description,
    mimeType: 'text/markdown',
    visibleTo: (caller: McpCaller) => recipeVisible(recipe, tools, caller),
    read: () => renderRecipe(recipe),
  }));
}
