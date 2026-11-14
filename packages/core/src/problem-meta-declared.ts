// Single responsibility: the APP table of which `meta` keys a code's problem document carries, and
// the one key rule. Moved down from `@ultimat3/http`'s `problem-meta.ts` as `public-cause.ts` was, so
// `defineError` (tier 0, on `./page`) can take `problemMeta:` in the code's one declaration. No
// titles table, no http: an island declaring an app code pays a `Map` and a regex for it.

import { renderCauseValue } from './error-render';

/**
 * A key is spelled the way a code's `meta` key is spelled in source. `issues` and `issuesTruncated`
 * each already have a top-level home in the document; a second copy under `meta` is two places for
 * a client to read one fact. `__proto__` is refused because the receiving `JSON.parse` mints it as
 * a real own key.
 */
const KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * Why `key` may not ride a document, or `undefined` when it may. The one rule for every writer: an
 * app's `defineError` and `registerProblemMeta` refuse on it, and http's framework table is held to
 * it by a test.
 */
export function metaKeyRefusal(key: unknown): string | undefined {
  if (typeof key !== 'string' || !KEY.test(key)) {
    return `${renderCauseValue(key)} is not a meta key`;
  }
  if (key === 'issues' || key === 'issuesTruncated') {
    return `\`${key}\` already rides at the top level of the document`;
  }
  if (key === '__proto__') return `\`${key}\` is not a key a document may carry`;
  return undefined;
}

/** Per app-owned code, the `meta` keys its documents carry. A `Map`: an own-key read, always. */
const DECLARED = new Map<string, readonly string[]>();

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, at) => key === right[at]);

/**
 * Why `keys` may not be recorded for `code`, or `undefined`. Read BEFORE any write, so a refused
 * declaration leaves no half behind. Whether the framework owns `code` is the caller's question:
 * `defineError` already refuses a registered code, http refuses one its status table maps.
 */
export function problemMetaRefusal(code: string, keys: readonly unknown[]): string | undefined {
  if (keys.length === 0) return 'the key list is empty — omit the code instead';
  for (const key of keys) {
    const refusal = metaKeyRefusal(key);
    if (refusal !== undefined) return refusal;
  }
  const existing = DECLARED.get(code);
  if (existing !== undefined && !sameKeys(existing, keys as readonly string[])) {
    return `already declared as [${existing.join(', ')}] by this app`;
  }
  return undefined;
}

/** The write, after `problemMetaRefusal` answered `undefined`. Copied, never aliased. */
export const recordProblemMeta = (code: string, keys: readonly string[]): void => {
  DECLARED.set(code, [...keys]);
};

/** The keys an app declared for `code`, or `undefined`. http's `problemMetaKeysFor` reads it. */
export const declaredProblemMeta = (code: string): readonly string[] | undefined =>
  DECLARED.get(code);

/** Test seam. Production declares once at boot and never forgets. */
export const resetDeclaredProblemMeta = (): void => {
  DECLARED.clear();
};
