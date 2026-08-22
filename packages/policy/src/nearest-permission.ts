// Single responsibility: the declared permission a mistyped one most likely meant, so
// `X_PERMISSION_UNKNOWN` can lead with the real name. Leading with "add '<the typo>' to
// definePermissions" told the caller to declare their own typo — a second permission nothing
// grants and nothing enforces, which is the guard answering a mistake by opening a hole.

/**
 * Levenshtein distance. A grid rather than two rolling rows because `noUncheckedIndexedAccess`
 * makes every read an `?? 0`, and one `at()` reads better than four of them.
 */
const distance = (a: string, b: string): number => {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[] = new Array<number>(rows * cols).fill(0);
  const at = (r: number, c: number): number => grid[r * cols + c] ?? 0;
  for (let r = 0; r < rows; r += 1) grid[r * cols] = r;
  for (let c = 0; c < cols; c += 1) grid[c] = c;
  for (let r = 1; r < rows; r += 1) {
    for (let c = 1; c < cols; c += 1) {
      const cost = a[r - 1] === b[c - 1] ? 0 : 1;
      grid[r * cols + c] = Math.min(at(r - 1, c) + 1, at(r, c - 1) + 1, at(r - 1, c - 1) + cost);
    }
  }
  return at(rows - 1, cols - 1);
};

/**
 * Within an edit distance of 3 — the same cutoff `x`'s own unknown-command suggestion uses, so a
 * name the CLI would suggest is the name this error suggests. Ties keep the first declared, which
 * is the order `definePermissions([...])` was written in.
 *
 * DUPLICATED from `packages/cli/src/parse.ts`'s `nearest`, deliberately and not by import: `cli`
 * is tier 5 and this package is tier 2, so that edge cannot exist. The shared home is
 * `@ultimat3/core` (tier 0); hoisting it there is one function and three call sites, and it
 * belongs to whoever changes core next rather than to a fix line in policy.
 */
export const nearestPermission = (input: string, known: readonly string[]): string | undefined => {
  let best: string | undefined;
  let bestScore = 4;
  for (const candidate of known) {
    const score = distance(input, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};
