/**
 * A translator that remembers what it could not answer, for a surface that refuses rather than
 * shows `⟦key⟧`: a mail cannot be taken back. It reads the render's own facts, never the bytes,
 * because user data may hold a `⟦`.
 */

import { placeholdersOf, selectMessageKey } from './interpolate';
import { isMiss, type TranslateVars, type Translator } from './translator';

/** One thing a render asked for and could not fill. A `slot` names a `{var}` of a key that exists. */
export interface TranslationMiss {
  readonly key: string;
  readonly slot?: string | undefined;
}

export interface RecordingTranslator {
  readonly t: Translator;
  /** Distinct misses so far, sorted: a key may be rendered more than once. */
  misses(): readonly TranslationMiss[];
}

/**
 * Picks the template through `selectMessageKey`, the selector `t()` itself uses, because `has()` is
 * too coarse to decide on: it says yes for a plural family read without a `count`, where `t()`
 * renders `⟦key⟧`. A value that is itself a marker is a miss too: it is what `x i18n sync` seeds, so
 * following a refusal's own fix must not be what delivers the brackets.
 */
export function recordingTranslator(base: Translator): RecordingTranslator {
  const misses = new Map<string, TranslationMiss>();
  const note = (key: string, slot?: string): void => {
    misses.set(slot === undefined ? key : `${key}{${slot}}`, { key, slot });
  };
  const exists = (candidate: string): boolean => base.raw(candidate) !== undefined;

  const inspect = (key: string, vars: TranslateVars | undefined): void => {
    const template = base.raw(selectMessageKey(key, vars, base.locale, exists));
    if (template === undefined || isMiss(template)) {
      note(key);
      return;
    }
    for (const slot of placeholdersOf(template)) {
      if (vars === undefined || !Object.hasOwn(vars, slot) || vars[slot] === undefined) {
        note(key, slot);
      }
    }
  };

  const t: Translator = Object.assign(
    (key: string, vars?: TranslateVars): string => {
      inspect(key, vars);
      return base(key, vars);
    },
    { has: base.has, raw: base.raw, keys: base.keys, locale: base.locale },
  );

  return {
    t,
    misses: () =>
      [...misses.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, miss]) => miss),
  };
}
