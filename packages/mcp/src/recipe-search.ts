/**
 * `docs({ q })`'s ranking, stated so it can be argued with: a recipe scores the query words it
 * contains — 3 for one in its name or title, 2 in its description, 1 in its body — each word once.
 * The best positive score is the hit. With none, the nearest names by edit distance are offered,
 * so a miss is never an empty answer while any recipe exists.
 */

import type { McpRecipe } from './recipes';
import { renderRecipe } from './recipes';

const NEAREST = 3;

const words = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2),
  );

export interface RecipeRanking {
  /** Positive scores, best first, ties by name. Empty is a miss. */
  readonly matches: readonly McpRecipe[];
  /** On a miss: the closest names. Empty only when there are no recipes at all. */
  readonly nearest: readonly McpRecipe[];
}

export function rankRecipes(recipes: readonly McpRecipe[], q: string): RecipeRanking {
  const asked = [...words(q)];
  const scored = recipes
    .map((recipe) => ({ recipe, score: scoreOf(recipe, asked) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.recipe.name.localeCompare(b.recipe.name));
  if (scored.length > 0) return { matches: scored.map((entry) => entry.recipe), nearest: [] };
  const target = q.toLowerCase().trim();
  const nearest = recipes
    .map((recipe) => ({ recipe, distance: closeness(recipe, target, asked) }))
    .sort((a, b) => a.distance - b.distance || a.recipe.name.localeCompare(b.recipe.name))
    .slice(0, NEAREST)
    .map((entry) => entry.recipe);
  return { matches: [], nearest };
}

function scoreOf(recipe: McpRecipe, asked: readonly string[]): number {
  const named = words(`${recipe.name} ${recipe.title}`);
  const described = words(recipe.description);
  const body = words(renderRecipe(recipe));
  let score = 0;
  for (const word of asked) {
    if (named.has(word)) score += 3;
    else if (described.has(word)) score += 2;
    else if (body.has(word)) score += 1;
  }
  return score;
}

/** The smallest edit distance from the query, or any of its words, to the name or a title word. */
function closeness(recipe: McpRecipe, target: string, asked: readonly string[]): number {
  const candidates = [recipe.name, ...words(recipe.title)];
  const probes = [target, ...asked];
  let best = Number.POSITIVE_INFINITY;
  for (const probe of probes) {
    for (const candidate of candidates) best = Math.min(best, distance(probe, candidate));
  }
  return best;
}

/** Levenshtein, two rows. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
