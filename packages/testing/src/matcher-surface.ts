// The custom matchers' declared surface, in ONE place: the `bun:test` augmentation, and the
// interface `matchers.ts` implements against. Split out of `matchers.ts` because every test
// program in the repo has to READ this declaration — `tsconfig.tests.json` names this file — and a
// tier-0 test cannot reach it by importing tier-5 `@ultimat3/testing`.

import type { VisibleOptions } from './matcher-visible';
import type { OpenApiLike } from './test-types';

/** A `defineMail()` handle, or its id. Structural, so this file imports no package. */
export type MatcherMailRef = string | { readonly id: string };

/** Who a mail must have gone to, beside which mail it was. */
export interface SentMailMatch {
  readonly to?: string;
}

/** The two members of a job handle `toHaveEnqueued` reads; `I` types the expected input. */
export interface EnqueuedJobRef<I> {
  readonly name: string;
  parse(raw: unknown): I;
}

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
  /**
   * `toEqual` for a repository ROW. A `.sealed()` column is an own property a row does not
   * ENUMERATE, so `toEqual({ …, password })` fails with an empty diff and `toEqual(otherRow)`
   * cannot see a wrong secret. This compares every own property, and its message names what
   * differs — a server-only property by shape, never by value.
   */
  toEqualRow(expected: unknown): T;
  /**
   * The one matcher that WAITS. Retries `isVisible()` to a budget — 5000ms every 100ms unless
   * narrowed — and `.not.toBeVisible()` waits for the element to GO rather than inverting one look.
   * Point-in-time is `expect(await locator.isVisible()).toBe(true)`, and it is a different
   * assertion: it fails on a page that simply has not painted yet.
   */
  toBeVisible(options?: VisibleOptions): Promise<T>;
  /**
   * On the `runJobs` fixture: a row for `job`, in any state, whose input equals `input` once both
   * are parsed by the job's schema (an input it refuses is `X_TEST_EXPECTED_INPUT_INVALID`).
   */
  toHaveEnqueued<I>(job: EnqueuedJobRef<I>, input?: I): Promise<T>;
  /** On the `mail` fixture: that mail was sent — to `to`, when named. */
  toHaveSentMail(mail: MatcherMailRef, match?: SentMailMatch): T;
}

declare module 'bun:test' {
  // `extends`, not a restatement: bun's own docs give this shape, and it keeps the member list on
  // `UltimateMatchers` where the implementation is checked against it.
  interface Matchers<T> extends UltimateMatchers<T> {}
}
