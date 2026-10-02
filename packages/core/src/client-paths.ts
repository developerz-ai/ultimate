/**
 * The ONE URL rule for the two HTTP primitives: an action's export name derives `POST
 * /api/<resource>/<verb>`, a query's derives `GET /_x/query/<kebab>`. Tier 0 and string math, so
 * `action`, `query` and `realtime` (all tier 3) derive the same URL with no sideways import and a
 * browser bundle pays a few hundred bytes for it. The one thing read rather than computed is the
 * style a caller did not name: `actionPath` takes it from the document the server rendered.
 */

import { CLIENT_PATH_STYLE_META } from './page-meta';

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
 * How an action's export name becomes its URL. Declared once per app
 * (`defineApi({ http: { pathStyle } })`), never per action — one app, one rule.
 *
 * | style | `publishPost` | `signIn` | `health` |
 * |---|---|---|---|
 * | `'resource'` (default) | `/api/posts/publish` | `/api/ins/sign` | `/api/healths/invoke` |
 * | `'readable'` | `/api/publish-post` | `/api/sign-in` | `/api/health` |
 *
 * `'resource'` guesses a noun from the words after the first and pluralizes it, which is right for
 * `verbNoun` names and ungrammatical for everything else. `'readable'` guesses nothing: the path IS
 * the name, kebab-cased — the rule `/_x/query/<kebab>` has always followed for reads.
 */
export type ActionPathStyle = 'resource' | 'readable';

export const ACTION_PATH_STYLES: readonly ActionPathStyle[] = ['resource', 'readable'];

/** Every action is served under one prefix, whichever style derives the rest. */
export const ACTION_PATH_PREFIX = '/api';

/**
 * `publishPost` -> `/api/posts/publish`, `updateUserProfile` -> `/api/user-profiles/update`,
 * `checkout` -> `/api/checkouts/invoke` (single-word fallback) — the `'resource'` style.
 * `'readable'` -> `/api/publish-post`, `/api/update-user-profile`, `/api/checkout`: `verb` is the
 * first word and `resource` the rest, both unpluralized, and neither is part of the path.
 */
export function actionRoute(name: string, style: ActionPathStyle = 'resource'): ActionRoute {
  const words = splitWords(name);
  if (style === 'readable') {
    const kebab = words.length === 0 ? 'invoke' : words.join('-');
    return {
      verb: words[0] ?? 'invoke',
      resource: words.length < 2 ? kebab : words.slice(1).join('-'),
      path: `${ACTION_PATH_PREFIX}/${kebab}`,
    };
  }
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

/**
 * The style the SERVER stamped into this document (`<meta name="ultimate-path-style">`), or
 * `undefined`: no document (a server, a worker, a script), no stamp (a `'resource'` server writes
 * none), or a value this build does not know. A style is a runtime value and a type is erased, so
 * this is the only way a browser learns it without the app restating it.
 */
export function renderedActionPathStyle(): ActionPathStyle | undefined {
  const doc: { querySelector?: (selector: string) => { content?: unknown } | null } | undefined =
    Reflect.get(globalThis, 'document');
  const stamped = doc?.querySelector?.(`meta[name="${CLIENT_PATH_STYLE_META}"]`)?.content;
  return ACTION_PATH_STYLES.find((known) => known === stamped);
}

/**
 * The path an action is POSTed to. A caller that names no `style` gets the document's — every
 * browser caller (`rpc`, `useMutation`, the outbox replay) derives under the one the server serves
 * — and `'resource'` where there is no document to ask. A named style is never overridden.
 */
export function actionPath(name: string, style?: ActionPathStyle): string {
  return actionRoute(name, style ?? renderedActionPathStyle() ?? 'resource').path;
}

/** `liveFeed` -> `/_x/query/live-feed`, read with `GET …?orgId=…`. */
export function queryPath(name: string): string {
  return `${QUERY_PATH_PREFIX}/${splitWords(name).join('-')}`;
}
