/**
 * `docs` — recipes for clients that ignore resources: `{}` lists (JSON, or a text map grouped by
 * section), `{ name }` / `{ uri }` reads one, `{ q }` inlines the best match or names the nearest.
 * Gated per recipe by the tools it names, so hidden and unknown are one not-found; a caller's own
 * recipes are marked `source: 'caller'`.
 */

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import { MAX_QUERY_LENGTH, rankRecipes } from './recipe-search';
import type { McpRecipe } from './recipes';
import {
  assertSection,
  recipeKey,
  recipeVisible,
  renderRecipe,
  sectionOf,
  uriOf,
  uriOfKey,
} from './recipes';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';

export const DOCS_TOOL = 'docs';

/** A caller's own recipes, asked per call — a tenant's runbooks beside the app's. */
export type ExtraRecipes = (
  caller: McpCaller,
) => Promise<readonly McpRecipe[]> | readonly McpRecipe[];

/** How `docs` presents itself: the app's own description, and the shape `docs({})` answers. */
export interface DocsToolOptions {
  /** Replaces the default tool description. */
  readonly description?: string;
  /**
   * `'json'` (default): `{ recipes: [{ name, title, description, uri, source }] }` — `name` is the
   * bare name, so outside `recipes` read by `uri` or `<section>/<name>`. `'map'`: plain
   * text, one `# <section>` heading per section, then one `<uri>  <title>` line per recipe.
   */
  readonly index?: 'json' | 'map';
}

/** One recipe this caller may follow, and where it came from. */
export interface SourcedRecipe {
  readonly recipe: McpRecipe;
  readonly source: 'app' | 'caller';
}

/** The app's recipes, then the caller's (a URI the app holds is never shadowed), all gated. */
export async function recipesFor(
  recipes: readonly McpRecipe[],
  extra: ExtraRecipes | undefined,
  catalog: readonly AnyMcpTool[],
  caller: McpCaller,
): Promise<readonly SourcedRecipe[]> {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const taken = new Set(recipes.map(uriOf));
  const own = extra === undefined ? [] : await extra(caller);
  for (const recipe of own) assertSection(recipe);
  return [
    ...recipes.map((recipe) => ({ recipe, source: 'app' as const })),
    ...own
      .filter((recipe) => !taken.has(uriOf(recipe)))
      .map((recipe) => ({ recipe, source: 'caller' as const })),
  ].filter((entry) => recipeVisible(entry.recipe, tools, caller));
}

export function recipesTool(
  recipes: readonly McpRecipe[],
  catalog: () => readonly AnyMcpTool[],
  extra?: ExtraRecipes,
  options: DocsToolOptions = {},
): AnyMcpTool {
  return {
    name: DOCS_TOOL,
    description:
      options.description ??
      'How-to recipes for this server. docs({}) lists the ones you can follow; docs({ q }) finds one by words and reads it; docs({ name }) or docs({ uri }) reads one: which tools to call, in order, with example arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'A recipe name: bare in the recipes section, <section>/<name> in any other. The uri docs({}) lists always works.',
        },
        uri: {
          type: 'string',
          description: 'A docs://<section>/<name> URI exactly as docs({}) or an error gives it.',
        },
        // A miss quotes `q` back and ranks every recipe against it: a megabyte of it is refused.
        q: {
          type: 'string',
          maxLength: MAX_QUERY_LENGTH,
          description: 'Words describing the task.',
        },
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
            ? args['uri']
            : undefined;
      if (named !== undefined) {
        const uri = uriOfKey(named);
        const found = visible.find((entry) => uriOf(entry.recipe) === uri);
        if (found === undefined) throw notFound(named);
        return text(renderRecipe(found.recipe));
      }
      if (typeof args['q'] === 'string' && args['q'].trim() !== '') {
        return text(answerQuery(visible, args['q']));
      }
      if (options.index === 'map') return text(renderMap(visible));
      return text(JSON.stringify({ recipes: visible.map(row) }));
    },
  };
}

const row = (entry: SourcedRecipe) => ({
  name: entry.recipe.name,
  title: entry.recipe.title,
  description: entry.recipe.description,
  uri: uriOf(entry.recipe),
  source: entry.source,
});

/** A line-per-entry answer: a title's own line breaks would split its entry. */
const oneLine = (title: string): string =>
  title.replace(/\s+/g, (space) => (/[\r\n\u2028\u2029]/.test(space) ? ' ' : space));

const yours = (entry: SourcedRecipe): string => (entry.source === 'caller' ? ' (yours)' : '');

/** Sections in first-seen order, each its `<uri>  <title>` lines: no tables, no nesting. */
function renderMap(visible: readonly SourcedRecipe[]): string {
  if (visible.length === 0) return 'No recipes are available to this caller.\n';
  const sections = new Map<string, string[]>();
  for (const entry of visible) {
    const lines = sections.get(sectionOf(entry.recipe)) ?? [];
    lines.push(`${uriOf(entry.recipe)}  ${oneLine(entry.recipe.title)}${yours(entry)}`);
    sections.set(sectionOf(entry.recipe), lines);
  }
  return `${[...sections].map(([section, lines]) => `# ${section}\n${lines.join('\n')}`).join('\n\n')}\n`;
}

/** The best match inlined, with the runners-up named; a miss names the nearest instead. */
function answerQuery(visible: readonly SourcedRecipe[], q: string): string {
  const sources = new Map(visible.map((entry) => [uriOf(entry.recipe), entry.source]));
  const { matches, nearest } = rankRecipes(
    visible.map((entry) => entry.recipe),
    q,
  );
  const line = (recipe: McpRecipe) =>
    `- docs({ name: '${recipeKey(recipe)}' }) — ${oneLine(recipe.title)}${sources.get(uriOf(recipe)) === 'caller' ? ' (yours)' : ''}`;
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
