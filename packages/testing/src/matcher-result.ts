// What every matcher in this package hands back. Its own module so `matcher-visible.ts` can carry
// the shape without importing `matchers.ts`, which imports it.

export interface MatcherResult {
  readonly pass: boolean;
  message(): string;
}
