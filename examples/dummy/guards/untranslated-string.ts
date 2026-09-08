// untranslated-string: every user-facing string on a rendered surface goes through `t()`.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_UNTRANSLATED_STRING';

/**
 * `<tag …>text</tag>`, matched on the CLOSING tag rather than on the next `<`.
 *
 * That is the whole reason this rule can run over TypeScript at all: `createSignal<State>('idle')`
 * is a `>` followed by prose-shaped source, and a pattern reading to the next `<` reports every
 * generic in the file. A closing tag that names the same element cannot be a type argument.
 *
 * Only the INNERMOST element matches — the content class excludes `<` and `>` — which is what the
 * rule wants: a parent whose children are elements has no text of its own.
 */
const ELEMENT = /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>([^<>]*?)<\/\1>/g;
/** Two word characters in a row. One is `&`, `×`, an initial — never a sentence. */
const PROSE = /[\p{L}\p{N}]{2,}/u;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * Every `{…}` child removed — `{t('key')}`, `{props.row.title}` — leaving only what was TYPED
 * between the tags.
 *
 * A depth scan and never a regex, because a JSX expression NESTS and a regex does not:
 * `/\{[^{}]*\}/g` strips the INNER group of
 * `{t('app.feed.heading', { org: actor.org.name })}` first, leaves the unbalanced remnant
 * `{t('app.feed.heading',  )}`, and then reads that remnant as prose — so every `t()` call with an
 * interpolation object or a template-literal key was reported as an untranslated string, which is
 * the exact opposite of the rule. Measured at 12 findings, all false, before this scan replaced it.
 *
 * A closing brace with nothing open is kept: it is a stray character, and prose it is not.
 */
const withoutExpressions = (children: string): string => {
  let out = '';
  let depth = 0;
  for (const character of children) {
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += character;
  }
  return out;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function untranslatedStrings(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(ELEMENT)) {
      const typed = withoutExpressions(match[2] ?? '').trim();
      if (!PROSE.test(typed)) continue;
      findings.push({
        code: CODE,
        cause: `${file.path}:${lineOf(text, match.index)} renders the typed string "${typed}" inside <${match[1] ?? 'element'}> — it is in no catalog, so every locale but the one it was typed in reads it verbatim`,
        fix: `add a key for "${typed}" to packages/i18n/catalogs/en.json, render it as {t('…')} in ${file.path}, then: x i18n check`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a rendered string comes from t(), never typed into the page',
  async check(root) {
    const files: SourceFile[] = [];
    // Every rendered surface: an app's `site/` and `app/`, and the shared components under
    // `packages/*/src` — `x new` scaffolds a `packages/ui` whose components render to a user, so
    // a hardcoded string there used to be green. `api/` renders nothing and `shared/` is a leaf of
    // helpers; `packages/*/dist` is a build output, not source.
    //
    // TWO globs, and the rule is that a brace ALTERNATIVE may not contain a `/`. Measured on Bun
    // 1.4.0 against `examples/dummy`: `{apps/*/{site,app},packages/*/src}/**/*.tsx` and
    // `{apps/web,packages/ui}/**/*.tsx` each match ZERO files, where `apps/*/{site,app}/**/*.tsx`
    // matches 17 — so folding these into one line silently turns the guard off, which is worse than
    // the hole it closes. A LEADING group is fine and four guards here rely on it:
    // `{apps,packages}/**/*.scss` matches all 15.
    for (const pattern of ['apps/*/{site,app}/**/*.tsx', 'packages/*/src/**/*.tsx']) {
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
        const path = entry.split('\\').join('/');
        if (path.includes('node_modules/') || /\.test\.tsx?$/.test(path)) continue;
        files.push({ path, source: await Bun.file(`${root}/${path}`).text() });
      }
    }
    return untranslatedStrings(files);
  },
};
