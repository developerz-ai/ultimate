/**
 * MCP recipes — "how do I do X here" as structure the boot checks: every step names a projected
 * tool and its example must pass that tool's input. Served as `docs://<section>/<name>` (section
 * `recipes` unless set) and through `docs`, only to a caller who can see and call every tool a
 * recipe names.
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
/** The section a recipe that names none is served under. */
export const DEFAULT_SECTION = 'recipes';
/**
 * A name and a section alike: lowercase letters and digits in groups joined by single `-`
 * (`ref-v2`, never `-ref`, `ref-` or `ref--v2`) — closed, so neither steps out of `docs://<section>/`.
 */
export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A `docs://<section>/` link and its whole path — `docs://ref/errors/old` and
 * `docs://ref/errors.html` are not `docs://ref/errors` — less the full stop that ends a sentence.
 */
const SECTIONED_LINK = /docs:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([A-Za-z0-9](?:[\w./~%-]*[\w/~%-])?)/g;
/** The section a `docs://<section>/…` URI sits in. */
const SECTION_OF_URI = /^docs:\/\/([^/]*)\//;

export interface McpRecipeStep {
  /** A tool THIS server projects, by name. Checked at boot. */
  readonly tool: string;
  /** Why this step, in the reader's words. */
  readonly why: string;
  /** Arguments for the tool, checked against its input schema at boot. */
  readonly example?: Readonly<Record<string, unknown>>;
}

export interface McpRecipe {
  /** Lowercase letters and digits in `-`-joined groups (`NAME`); the URI is `docs://<section>/<name>`. */
  readonly name: string;
  /** Spelled like `name`, `recipes` when unset: one `docs({})` group and one `docs://<section>/` prefix. */
  readonly section?: string;
  /** Other words for it: `docs({ q })` scores each as it scores the title. */
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly steps: readonly McpRecipeStep[];
  /** Free text, unchecked: where a tool is named, it is a step. */
  readonly notes?: string;
  /**
   * Markdown served as given in place of the rendered steps — what `markdownRecipes({ dir })`
   * builds from a file (LF line ends, outer blank lines dropped), its ```call fences becoming
   * `steps`, so they are checked all the same.
   */
  readonly body?: string;
}

export const recipeUri = (name: string, section: string = DEFAULT_SECTION): string =>
  `docs://${section}/${name}`;

/** The URI one recipe is served at. */
export const uriOf = (recipe: McpRecipe): string => recipeUri(recipe.name, recipe.section);

/** The section one recipe is listed under. */
export const sectionOf = (recipe: McpRecipe): string => recipe.section ?? DEFAULT_SECTION;

/** `docs({ name })`'s spelling: the bare name in `recipes`, `<section>/<name>` elsewhere. */
export const recipeKey = (recipe: McpRecipe): string =>
  sectionOf(recipe) === DEFAULT_SECTION ? recipe.name : `${sectionOf(recipe)}/${recipe.name}`;

/** The URI a `docs({ name })` / `docs({ uri })` argument names: a URI, `<section>/<name>` or a name. */
export const uriOfKey = (key: string): string =>
  key.startsWith('docs://') ? key : key.includes('/') ? `docs://${key}` : recipeUri(key);

/** A section outside the closed pattern is refused before it becomes part of a URI. */
export function assertSection(recipe: McpRecipe): void {
  if (recipe.section !== undefined && !NAME.test(recipe.section)) {
    throw new McpRecipeUriReservedError({ uri: uriOf(recipe), reason: 'section' });
  }
}

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
    const uri = uriOf(recipe);
    if (!NAME.test(recipe.name)) throw new McpRecipeUriReservedError({ uri, reason: 'name' });
    assertSection(recipe);
    if (seen.has(uri)) throw new McpRecipeUriReservedError({ uri, reason: 'duplicate' });
    seen.add(uri);
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

/** `recipes`, then every section `recipes` holds: the `docs://` prefixes this set owns. */
export const sectionsOf = (recipes: readonly McpRecipe[]): ReadonlySet<string> =>
  new Set([DEFAULT_SECTION, ...recipes.map(sectionOf)]);

/**
 * Every recipe URI a recipe's text names, as written — in a section `sections` holds. A link into
 * any other `docs://` prefix is somebody else's resource, and not judged here.
 */
export function recipeLinks(recipe: McpRecipe, sections: ReadonlySet<string>): readonly string[] {
  const text = `${recipe.body ?? ''}\n${recipe.notes ?? ''}`;
  return [...text.matchAll(SECTIONED_LINK)]
    .filter((match) => sections.has(match[1] as string))
    .map((match) => recipeUri(match[2] as string, match[1] as string));
}

/** A recipe pointing at one that does not exist is the stale link this whole file refuses. */
function assertRecipeBodyLinks(recipes: readonly McpRecipe[]): void {
  const uris = new Set(recipes.map(uriOf));
  const sections = sectionsOf(recipes);
  const offenders = recipes.flatMap((recipe) =>
    recipeLinks(recipe, sections)
      .filter((uri) => !uris.has(uri))
      .map((uri) => `recipe "${recipe.name}" links to ${uri}`),
  );
  if (offenders.length > 0) {
    throw new McpRecipeLinkDanglingError({
      offenders,
      recipes: recipes.map(recipeKey).sort(),
    });
  }
}

/** A hand-written resource may not take a `docs://<section>/` prefix `recipes:` owns. */
export function assertNoRecipeResources(
  resources: readonly McpResource[],
  recipes: readonly McpRecipe[],
): void {
  const sections = sectionsOf(recipes);
  const taken = resources.find((resource) => {
    const section = SECTION_OF_URI.exec(resource.uri)?.[1];
    return section !== undefined && sections.has(section);
  });
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
    uri: uriOf(recipe),
    name: recipe.title,
    description: recipe.description,
    mimeType: 'text/markdown',
    visibleTo: (caller: McpCaller) => recipeVisible(recipe, tools, caller),
    read: () => renderRecipe(recipe),
  }));
}
