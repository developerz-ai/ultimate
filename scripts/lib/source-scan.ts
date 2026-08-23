// The three helpers every text rule over source needs, in one place. Data-free and dependency-free
// — `scripts/boundaries.ts` reaches this tree and must keep running with no `node_modules`.
//
// WHY IT EXISTS. Five scripts kept private copies (#282) and the copies had DIVERGED: `isTest` was
// spelt `/\.(test|spec)\.tsx?$/` in `render-modes.ts`, `frozen-records.ts` and `side-effects.ts`
// and `/\.(?:test|spec|d)\.tsx?$/` in `error-render.ts` and `catch-render.ts`, so three rules read
// a `.d.ts` as shipped source and two skipped it. `lineOf` had two implementations. A rule whose
// corpus depends on which file it was copied from is a rule nobody can predict.

/**
 * A file whose contents are a test's own INPUT rather than shipped source.
 *
 * `test`/`spec` and NOTHING else, which is the narrow of the two forms this replaced. A `.d.ts` is
 * shipped source: `packages/ui/src/scss.d.ts` is the tree's only one today and trips no rule, but
 * a declaration file can carry `type RenderMode = 'static' | 'ssr'` — the exact vocabulary copy
 * `render-modes.ts` exists to refuse — and the wide form would have made that copy invisible in
 * the one place it is easiest to write. The narrow form's cost is the reverse and is zero: a
 * declaration file has no `Object.freeze`, no `cause:` and no import-time statement, so the rules
 * that used the wide form gain no findings from reading one.
 *
 * A caller that genuinely means "has no runtime" asks `isDeclaration` instead. Two questions, two
 * names — the merged predicate is what let the divergence hide for five copies.
 */
export const isTestPath = (path: string): boolean => /\.(?:test|spec)\.tsx?$/.test(path);

/** A `.d.ts` / `.d.tsx`: types only, so it emits nothing and runs at no time. */
export const isDeclaration = (path: string): boolean => /\.d\.tsx?$/.test(path);

/**
 * 1-based line of a character index. The char loop rather than `slice().split().length`: identical
 * answers, and no allocation of a prefix that can be the whole file on every call — these scanners
 * ask it once per finding inside a walk over every file in the repo.
 */
export const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

/**
 * Whether the declaration `decl` found at `index` is CODE, asked of a mask where a string's
 * contents are blanked and every offset is preserved — so the keyword survives exactly when it was
 * never inside one. `@ultimat3/cli`'s scaffold templates emit app source inside template literals,
 * and reading one of those as a declaration invents a finding no edit can clear.
 */
export const isCode = (masked: string, index: number, decl: string): boolean =>
  masked[index + (decl.length - decl.trimStart().length)] !== ' ';
