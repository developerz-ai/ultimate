// Emitting a line the way Biome would print it. A template cannot run a formatter, so generated
// source is written pre-formatted — and a FIXED shape is wrong for one name length or the other:
// Biome joins a short wrapped call back onto one line and breaks a long joined one, and the app's
// own `lint` step fails on whichever half the template guessed wrong.

/** The scaffold's own `biome.json` says `lineWidth: 100`, and this is the same number. */
export const LINE_WIDTH = 100;

/**
 * `<open><a>, <b><close>` when it fits, one entry per line with a trailing comma when it does not.
 * The one shape behind every generated argument list, array literal and parameter list — a second
 * copy of this rule is how `x g entity credit-note-attachment` shipped a `$view([…])` line that the
 * app's formatter rewrote on sight.
 */
export function wrapList(
  indent: string,
  open: string,
  entries: readonly string[],
  close: string,
): string {
  const joined = `${indent}${open}${entries.join(', ')}${close}`;
  if (joined.length <= LINE_WIDTH) return joined;
  const body = entries.map((entry) => `${indent}  ${entry},`).join('\n');
  return `${indent}${open}\n${body}\n${indent}${close}`;
}

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/** How many digits run from `at`. A run is compared as a number, so `b2` precedes `b10`. */
const digitRun = (text: string, at: number): number => {
  let end = at;
  while (end < text.length && isDigit(text[end] ?? '')) end += 1;
  return end - at;
};

/**
 * Biome's own order for the names inside `{ … }`, measured against 2.5.8 rather than assumed —
 * three behaviours, and no single-pass compare gives all three:
 *
 *   `{ post, PostView }`  → `{ PostView, post }`   upper first on a pure case tie
 *   `{ Zeta, alpha }`     → `{ alpha, Zeta }`      but case is only ever the TIEBREAK
 *   `{ b10, b2 }`         → `{ b2, b10 }`          a digit run compares as a number
 *
 * The first two together are why folding to lower case and comparing is wrong: `post` is a prefix
 * of `postview`, so a folded compare puts `post` first and Biome does not.
 */
const compareSpecifiers = (left: string, right: string): number => {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const runA = digitRun(left, a);
    const runB = digitRun(right, b);
    if (runA > 0 && runB > 0) {
      const valueA = Number(left.slice(a, a + runA));
      const valueB = Number(right.slice(b, b + runB));
      if (valueA !== valueB) return valueA - valueB;
      a += runA;
      b += runB;
      continue;
    }
    const charA = left[a] ?? '';
    const charB = right[b] ?? '';
    const foldedA = charA.toLowerCase();
    const foldedB = charB.toLowerCase();
    if (foldedA !== foldedB) return foldedA < foldedB ? -1 : 1;
    // Same letter, different case: uppercase wins HERE rather than after the whole string, which
    // is what makes `PostView` precede `post` instead of following it.
    if (charA !== charB) return charA < charB ? -1 : 1;
    a += 1;
    b += 1;
  }
  return left.length - right.length;
};

/**
 * The names of an import, in the order Biome would leave them. `assist/source/organizeImports` is
 * an ERROR under the scaffold's config, and the order is decided by the FEATURE NAME, not by the
 * template: `x g action audit-log --feature billing` emitted `{ canBillingWrite, billingTag }`, so
 * every feature starting `a` or `b` wrote a failing `lint` step into the app. Sorted here rather
 * than spelled in each template, because the correct spelling is not knowable at authoring time.
 */
export const sortSpecifiers = (names: readonly string[]): readonly string[] =>
  [...names].sort(compareSpecifiers);

/**
 * A named import, sorted and wrapped. Its own function because the braces are spaced on one line
 * (`import { a, b } from …`) and not spaced when broken — `wrapList` would emit `import {a, b}`
 * joined, or a stray space before the closing brace when broken.
 */
export function wrapImport(names: readonly string[], from: string): string {
  const sorted = sortSpecifiers(names);
  const joined = `import { ${sorted.join(', ')} } from '${from}';`;
  if (joined.length <= LINE_WIDTH) return joined;
  return `import {\n${sorted.map((name) => `  ${name},`).join('\n')}\n} from '${from}';`;
}
