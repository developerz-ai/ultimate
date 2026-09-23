/**
 * The ONE URL rule for the two HTTP primitives: an action's export name derives `POST
 * /api/<resource>/<verb>`, a query's derives `GET /_x/query/<kebab>`. Tier 0 and pure string math,
 * so `action`, `query` and `realtime` (all tier 3) derive the same URL with no sideways import and
 * a browser bundle pays a few hundred bytes for it. Moved verbatim from both packages' `naming.ts`.
 */

/** Irregular plurals we actually hit in domain models. A `Map`: the key is a caller's word. */
const IRREGULAR: ReadonlyMap<string, string> = new Map([
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['datum', 'data'],
  ['index', 'indexes'],
  ['entry', 'entries'],
]);

/** Every read is served under one prefix, so a router can claim it in one rule. */
export const QUERY_PATH_PREFIX = '/_x/query';

export interface ActionRoute {
  /** First camelCase word, kebab-cased. `publishPost` -> `publish`. */
  readonly verb: string;
  /** Remaining words, last one pluralized, kebab-cased. `publishPost` -> `posts`. */
  readonly resource: string;
  /** `/api/<resource>/<verb>`. */
  readonly path: string;
}

/** camelCase / PascalCase / SCREAMING_SNAKE -> lowercase words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Naive-on-purpose English pluralizer. A word that already ends in `s` is left alone, so
 * `publishPosts` and `publishPost` agree on the `posts` resource.
 */
export function pluralize(word: string): string {
  const irregular = IRREGULAR.get(word);
  if (irregular !== undefined) return irregular;
  if (word.endsWith('s')) return word;
  if (/(x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * `publishPost` -> `/api/posts/publish`, `updateUserProfile` -> `/api/user-profiles/update`,
 * `checkout` -> `/api/checkouts/invoke` (single-word fallback).
 */
export function actionRoute(name: string): ActionRoute {
  const words = splitWords(name);
  const head = words[0] ?? 'invoke';
  if (words.length < 2) {
    const resource = pluralize(head);
    return { verb: 'invoke', resource, path: `/api/${resource}/invoke` };
  }
  const nouns = words.slice(1);
  const last = nouns[nouns.length - 1] ?? head;
  const resource = [...nouns.slice(0, -1), pluralize(last)].join('-');
  return { verb: head, resource, path: `/api/${resource}/${head}` };
}

/** The path an action is POSTed to — `actionRoute(name).path`. */
export function actionPath(name: string): string {
  return actionRoute(name).path;
}

/** `liveFeed` -> `/_x/query/live-feed`, read with `GET …?orgId=…`. */
export function queryPath(name: string): string {
  return `${QUERY_PATH_PREFIX}/${splitWords(name).join('-')}`;
}
