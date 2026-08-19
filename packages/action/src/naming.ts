/**
 * The one naming rule: an action's export name derives its HTTP path and its
 * OpenAPI component names. Pure string math so the browser client can derive
 * the same path without importing a byte of server code. The MCP tool name is
 * derived by nothing — it is the export name verbatim.
 */

/** Irregular plurals we actually hit in domain models. Extend deliberately, not eagerly. */
const IRREGULAR: Readonly<Record<string, string>> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  datum: 'data',
  index: 'indexes',
  entry: 'entries',
};

export interface ActionPath {
  /** First camelCase word, kebab-cased. `publishPost` -> `publish`. */
  readonly verb: string;
  /** Remaining words, last one pluralized, kebab-cased. `publishPost` -> `posts`. */
  readonly resource: string;
  /** `POST /api/<resource>/<verb>`. */
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
 * Naive-on-purpose English pluralizer. A word that already ends in `s` is left
 * alone, so `publishPosts` and `publishPost` agree on the `posts` resource.
 */
export function pluralize(word: string): string {
  // `Object.hasOwn`, never a truthiness check on the read: `IRREGULAR['constructor']` is the
  // `Object` FUNCTION off the prototype chain, not `undefined`, and `splitWords` lowercases —
  // which keeps `toString` out of reach and lets `constructor` straight through. `pluralize` is
  // public API returning `string`, and `derivePath` publishes what it answers as the action's
  // HTTP path, its OpenAPI `paths` key and its `tags` entry.
  if (Object.hasOwn(IRREGULAR, word)) return IRREGULAR[word] ?? word;
  if (word.endsWith('s')) return word;
  if (/(x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * `publishPost`        -> POST /api/posts/publish
 * `updateUserProfile`  -> POST /api/user-profiles/update
 * `likePost`           -> POST /api/posts/like
 * `checkout`           -> POST /api/checkouts/invoke   (single-word fallback)
 */
export function derivePath(name: string): ActionPath {
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

// There is deliberately no `toToolName`. An MCP tool name is the export name verbatim — the one
// `@ultimat3/mcp` serves and the one a `tools/call` spells — so a second derivation would be a
// second name for one action, which is what shipped `publish_post` in two committed contracts.

/** OpenAPI `operationId` is the action name verbatim — it is already unique. */
export function toOperationId(name: string): string {
  return name;
}

const pascal = (name: string): string =>
  splitWords(name)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join('');

/** OpenAPI component name for an action's input schema. */
export function inputSchemaName(name: string): string {
  return `${pascal(name)}Input`;
}

/** OpenAPI component name for an action's output schema. */
export function outputSchemaName(name: string): string {
  return `${pascal(name)}Output`;
}

/** RFC 9457 body shared by every error response. */
export const PROBLEM_SCHEMA_NAME = 'Problem';

export function schemaRef(component: string): string {
  return `#/components/schemas/${component}`;
}
