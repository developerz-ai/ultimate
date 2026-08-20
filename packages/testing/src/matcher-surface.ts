// The custom matchers' declared surface, in ONE place: the `bun:test` augmentation, and the
// interface `matchers.ts` implements against. Split out of `matchers.ts` because every test
// program in the repo has to READ this declaration — `tsconfig.tests.json` names this file — and a
// tier-0 test cannot reach it by importing tier-5 `@ultimat3/testing`.

import type { OpenApiLike } from './test-types';

/**
 * One entry per `expect.extend` implementation in `matchers.ts`, and `T` is what the matcher
 * answers with. Adding a matcher is one edit here: `matchers.ts` will not compile until it has an
 * implementation whose arguments match, because its `expect.extend` argument is typed from this.
 *
 * A `.ts` and not a `.d.ts`, deliberately: `.gitignore` treats every `.d.ts` under a package's
 * `src` as stale `tsc` emit and drops it, and the one hand-written exception
 * (`packages/ui/src/scss.d.ts`) had to be un-ignored by name. A declaration needs no `.d.ts` to be
 * ambient — `declare module` in any file the program reads is the augmentation.
 */
export interface UltimateMatchers<T> {
  toBeUltimateError(code?: string): T;
  toDenyPolicy(context: Readonly<Record<string, unknown>>): Promise<T>;
  toEmitSteps(steps: readonly string[]): Promise<T>;
  toMatchOpenApi(committed: OpenApiLike): T;
  toBeWithinBudget(limit: number): T;
  toRejectInput(input: unknown): Promise<T>;
  toAcceptInput(input: unknown): Promise<T>;
}

declare module 'bun:test' {
  // `extends`, not a restatement: bun's own docs give this shape, and it keeps the member list on
  // `UltimateMatchers` where the implementation is checked against it.
  interface Matchers<T> extends UltimateMatchers<T> {}
}
