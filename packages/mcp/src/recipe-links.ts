// Whether a `docs://recipes/<name>` link on an error goes anywhere. `defineAppMcp` notes the recipes
// each endpoint serves; the CLI's load check holds every DECLARED link (`defineError({ docs })`) to
// the union of them, and the render drops — and logs — a link built at a throw site that names none.
// With no `recipes:` anywhere in the process nothing is judged: the prefix is not claimed yet.

import { listErrorCodes, tryUseContext } from '@ultimat3/core';
import { McpRecipeUnknownError } from './recipe-errors';
import { recipeNameOf } from './recipes';

const SERVED = new Set<string>();

export function noteServedRecipes(names: readonly string[]): void {
  for (const name of names) SERVED.add(name);
}

/** Every recipe any endpoint of this process serves. */
export const servedRecipes = (): ReadonlySet<string> => SERVED;

/** The link to render: itself, or `undefined` for a recipe URI nothing serves (logged). */
export function screenRecipeLink(docs: string, code: string): string | undefined {
  const name = recipeNameOf(docs);
  if (name === undefined || SERVED.size === 0 || SERVED.has(name)) return docs;
  tryUseContext()?.logger.warn('mcp.recipe.link-dropped', { code, uri: docs });
  return undefined;
}

/**
 * Every registered error code whose declared `docs` is a recipe URI none of `served` names. The
 * first is thrown, every one is in its `meta.unresolved`. `served` is the union over endpoints.
 */
export function assertRecipeLinks(served: ReadonlySet<string>): void {
  if (served.size === 0) return;
  const unresolved = listErrorCodes().filter((entry) => {
    const name = recipeNameOf(entry.docs);
    return name !== undefined && !served.has(name);
  });
  const first = unresolved[0];
  if (first === undefined) return;
  throw new McpRecipeUnknownError({
    uri: first.docs,
    code: unresolved.map((entry) => entry.code).join(', '),
    recipes: [...served].sort(),
  });
}

/** Test seam: forget every noted recipe, so one file's servers do not judge the next file's links. */
export function resetServedRecipes(): void {
  SERVED.clear();
}
