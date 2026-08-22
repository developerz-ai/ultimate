// Single responsibility: the declared name a mistyped one most likely meant, so any error can lead
// with the real one. It lives in core because three packages need the same answer — `@ultimat3/cli`
// for an unknown command, flag or positional, `@ultimat3/policy` for an unknown permission — and
// two copies of one cutoff are two suggestions for one typo.

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

/** Past this many edits the "suggestion" is a different word, and a wrong lead is worse than none. */
const MAX_EDITS = 3;

/**
 * The nearest candidate within `MAX_EDITS`, or `undefined` when nothing is close enough. Ties keep
 * the FIRST candidate, which is the order the caller declared them in — `definePermissions([...])`
 * and a `CommandSpec` list are both authored orders, and a stable answer is what lets a test pin one.
 */
export const nearestName = (input: string, candidates: readonly string[]): string | undefined => {
  let best: string | undefined;
  let bestScore = MAX_EDITS + 1;
  for (const candidate of candidates) {
    const score = distance(input, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};
