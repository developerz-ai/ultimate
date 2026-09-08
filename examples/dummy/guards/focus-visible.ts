// focus-visible: the focus ring is replaced, never only removed.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_FOCUS_VISIBLE';

/**
 * A DECLARATION, never a whole line: a selector carries no colon, so `.outline { … }` is not a
 * value and is never reported. The value stops at the first `;`, `{` or `}`.
 */
const DECLARATION = /([\w-]+)\s*:\s*([^;{}]+)/g;

/** The three spellings that take the ring away. `outline-offset` moves it and is not one. */
const REMOVES = new Set(['outline', 'outline-style', 'outline-width']);
const NOTHING = /^(?:none|0(?:px|em|rem)?)$/i;

/**
 * What counts as painting one back, and its shape is load-bearing twice over. The lookahead reads
 * the WHOLE value, not its first token: anchored on a prefix, `box-shadow: 0 0 0 2px …` — the
 * canonical focus ring — read as the removal spelled again. And it sits directly after the `:`
 * rather than after the space that follows it, because a `\s*` OUTSIDE a negative lookahead
 * backtracks to zero width and hands the lookahead a space to fail against: measured,
 * `outline: none` then counted as an indicator and every removal in the tree read as replaced.
 */
const INDICATOR =
  /(?<![\w-])(?:box-shadow|outline)\s*:(?!\s*(?:none|0(?:px|em|rem)?)\s*[;}])\s*[^;{}]+/;
const FOCUS_VISIBLE = /:focus-visible\b/;
/** `@include tokens.focus-ring` emits the whole rule, and no text scan can see inside a mixin. */
const FOCUS_MIXIN = /@include\s+[\w.-]*focus[\w-]*/i;
/**
 * `&:focus:not(:focus-visible) { outline: none }` is the CORRECT idiom, not the defect: it removes
 * the ring for a mouse press and leaves the keyboard one alone. Reported, it would teach an author
 * to switch this guard off — which is how a rule stops existing.
 */
const MOUSE_ONLY = /:not\(\s*:focus-visible\s*\)/;

/**
 * How far past a rule a replacement still counts as beside it. A sibling `:focus-visible` rule is
 * the second of the two shapes authors write; further than this it is a different component, and a
 * rule that searched the whole file would be satisfied by one focus style anywhere in it.
 */
const ADJACENT_CHARS = 600;

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

/**
 * Comments blanked rather than removed, so the reported line number still points at the source
 * line. `//` is skipped when a `:` precedes it — `url(https://…)` is a value, not a comment.
 */
const blankComments = (scss: string): string =>
  scss
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * The innermost `{ … }` the index sits inside — back to the nearest unmatched `{`, forward to the
 * `}` that closes it. Nested rules are INSIDE the answer, which is what makes the common Sass
 * shape (`.btn { outline: none; &:focus-visible { box-shadow: … } }`) read as one scope.
 */
function blockAround(
  text: string,
  index: number,
): { readonly start: number; readonly end: number } {
  let depth = 0;
  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  depth = 0;
  let end = text.length;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    }
  }
  return { start, end };
}

/** The selector this block belongs to: back to whatever ended the statement before it. */
function selectorBefore(text: string, start: number): string {
  let from = 0;
  for (let i = start - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '{' || ch === '}' || ch === ';') {
      from = i + 1;
      break;
    }
  }
  return text.slice(from, start);
}

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unreplacedFocusRings(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = (match[1] ?? '').toLowerCase();
      const value = (match[2] ?? '').trim();
      if (!REMOVES.has(property) || !NOTHING.test(value)) continue;
      const block = blockAround(scss, match.index);
      const selector = selectorBefore(scss, block.start);
      if (MOUSE_ONLY.test(selector)) continue;
      // The rule itself, its own selector, and what sits directly after it — the two shapes an
      // author writes a replacement in, and nothing wider, so a finding never has to be argued with.
      const scope =
        selector + scss.slice(block.start, Math.min(block.end + ADJACENT_CHARS, scss.length));
      if (FOCUS_MIXIN.test(scope)) continue;
      if (FOCUS_VISIBLE.test(scope) && INDICATOR.test(scope)) continue;
      findings.push({
        code: CODE,
        cause: `${file.path}:${lineOf(scss, match.index)} removes the focus ring with ${property}: ${value} and nothing in the rule or beside it paints one back — a keyboard user loses every trace of where they are, and WCAG 2.2 asks for an indicator at least 2px around the control at 3:1 against what is behind it`,
        fix: `add \`@include tokens.focus-ring;\` to the rule at ${file.path}:${lineOf(scss, match.index)}, or a sibling \`:focus-visible\` rule with a box-shadow — which follows the border radius where an outline does not — then: x verify`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a stylesheet replaces the focus ring, never only removes it',
  async check(root) {
    const files: StyleFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.scss').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\').join('/');
      if (path.includes('node_modules/')) continue;
      files.push({ path, scss: await Bun.file(`${root}/${path}`).text() });
    }
    return unreplacedFocusRings(files);
  },
};
