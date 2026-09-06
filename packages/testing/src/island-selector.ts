// The selector grammar the island micro-DOM answers, and the refusal for everything outside it.
//
// Split out of `island-dom.ts` at the 500-line ceiling. Until `As of 2026-09-05` the whole grammar
// was one regex — `[data-role="preview"]` or a bare tag — and a selector outside it was not
// refused, it MATCHED NOTHING: `find('[data-role="list"] button')` read as a tag named
// `[data-role="list"] button`, answered `null`, and the assertion after it failed on the wrong
// question. A virtualized list — rows inside a scroller inside a panel — cannot be addressed one
// element at a time, which is what the app that measured this was left doing.
//
// Small on purpose: compounds of tag, `#id`, `.class`, `[attr]` and `[attr="value"]`, joined by the
// descendant (whitespace) and child (`>`) combinators. No `,`, no sibling combinators, no
// pseudo-classes — each is a CSS engine's worth of edge cases, and a DOM library may not be added.
// Anything else throws `X_TEST_ISLAND_SELECTOR_UNSUPPORTED` naming the fragment, because a
// selector silently matching nothing is the hole this file replaces.

import { UltimateError } from '@ultimat3/core';

/** The element surface the matcher reads. Structural, so this module imports no DOM class. */
export interface SelectableElement {
  readonly tagName: string;
  /** Whatever the tree's parent type is — a fragment root without a tag is not an element. */
  readonly parentNode: object | null;
  getAttribute(name: string): string | null;
}

const isSelectable = (node: object): node is SelectableElement =>
  typeof (node as { tagName?: unknown }).tagName === 'string' &&
  typeof (node as { getAttribute?: unknown }).getAttribute === 'function';

/** `tag`, `#id`, `.class`, `[attr]`, `[attr="v"]`, `[attr='v']` — one simple selector each. */
const SIMPLE = /\*|[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/y;

interface Compound {
  readonly tag: string | undefined;
  readonly id: string | undefined;
  readonly classes: readonly string[];
  readonly attributes: readonly { readonly name: string; readonly value: string | undefined }[];
}

/** `descendant` is whitespace, `child` is `>`. The first compound has no combinator before it. */
type Combinator = 'descendant' | 'child';

interface Step {
  readonly combinator: Combinator;
  readonly compound: Compound;
}

export interface ParsedSelector {
  readonly source: string;
  readonly steps: readonly Step[];
}

/** The grammar, in the words the fix line prints. One string, so the two can never disagree. */
export const SELECTOR_GRAMMAR =
  'a tag, #id, .class, [attr] or [attr="value"], compounded (li[data-role="row"]) and joined by a ' +
  'space (descendant) or > (child)';

export class IslandSelectorUnsupportedError extends UltimateError {
  constructor(input: { selector: string; at: number }) {
    const fragment = input.selector.slice(input.at, input.at + 12);
    super({
      code: 'X_TEST_ISLAND_SELECTOR_UNSUPPORTED',
      cause: `${JSON.stringify(input.selector)} is not in the island DOM's selector grammar — the part it cannot read starts at ${JSON.stringify(fragment)} (offset ${input.at})`,
      fix: `spell the selector as ${SELECTOR_GRAMMAR}; a pseudo-class, a comma or a sibling combinator needs a browser test`,
    });
  }
}

const parseCompound = (selector: string, from: number): { compound: Compound; end: number } => {
  let tag: string | undefined;
  let id: string | undefined;
  const classes: string[] = [];
  const attributes: { name: string; value: string | undefined }[] = [];
  let at = from;
  for (;;) {
    SIMPLE.lastIndex = at;
    const match = SIMPLE.exec(selector);
    if (match === null) break;
    const token = match[0];
    if (token === '*') {
      /* universal: matches every element */
    } else if (token.startsWith('#')) id = token.slice(1);
    else if (token.startsWith('.')) classes.push(token.slice(1));
    else if (token.startsWith('[')) {
      attributes.push({ name: match[1] as string, value: match[2] ?? match[3] });
    } else if (tag === undefined && at === from) tag = token;
    // A tag AFTER an id, class or attribute is two compounds with no combinator between them,
    // which is not a selector: `[a]li` is refused rather than read as `[a] li`.
    else break;
    at += token.length;
  }
  if (at === from) throw new IslandSelectorUnsupportedError({ selector, at: from });
  return { compound: { tag, id, classes, attributes }, end: at };
};

/**
 * Left to right into steps; matched right to left by `matchesSelector`. Throws at the first
 * character the grammar does not cover, with its offset — a refusal a reader can act on, where
 * "matched nothing" is one they have to guess at.
 */
export function parseSelector(selector: string): ParsedSelector {
  const steps: Step[] = [];
  let at = 0;
  let combinator: Combinator = 'descendant';
  const skipSpaces = (): void => {
    while (selector[at] === ' ' || selector[at] === '\t' || selector[at] === '\n') at += 1;
  };
  skipSpaces();
  if (at === selector.length) throw new IslandSelectorUnsupportedError({ selector, at: 0 });
  for (;;) {
    const { compound, end } = parseCompound(selector, at);
    steps.push({ combinator, compound });
    at = end;
    const beforeSpaces = at;
    skipSpaces();
    if (at === selector.length) return { source: selector, steps };
    if (selector[at] === '>') {
      combinator = 'child';
      at += 1;
      skipSpaces();
    } else if (at > beforeSpaces) combinator = 'descendant';
    // No whitespace and no `>` between two tokens the compound parser stopped on: `[a]li`,
    // `li:first-child`, `a, b`, `a + b` — every one of them a shape this grammar does not read.
    else throw new IslandSelectorUnsupportedError({ selector, at });
  }
}

const classesOf = (element: SelectableElement): readonly string[] =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter((name) => name.length > 0);

const matchesCompound = (element: SelectableElement, compound: Compound): boolean => {
  if (compound.tag !== undefined && compound.tag !== element.tagName) return false;
  if (compound.id !== undefined && element.getAttribute('id') !== compound.id) return false;
  if (compound.classes.length > 0) {
    const own = classesOf(element);
    if (!compound.classes.every((name) => own.includes(name))) return false;
  }
  for (const { name, value } of compound.attributes) {
    const actual = element.getAttribute(name);
    if (value === undefined ? actual === null : actual !== value) return false;
  }
  return true;
};

/** The element's parent when it is an element — a document or fragment root has no `tagName`. */
const parentElement = (element: SelectableElement): SelectableElement | null => {
  const parent = element.parentNode;
  return parent !== null && isSelectable(parent) ? parent : null;
};

/**
 * Right to left, as CSS matches: the LAST compound is the element itself, and each earlier one
 * names its parent (`>`) or some ancestor (a space) — with backtracking over ancestors, so
 * `a b c` matches a `c` under a `b` under an `a` at any depth, and `a > b` does NOT match `b`'s
 * grandchildren. Ancestors ABOVE the element `querySelectorAll` was called on count, which is also
 * the DOM's rule: `host.querySelectorAll('div p')` finds a `p` whose `div` is the host itself.
 */
export function matchesSelector(element: SelectableElement, parsed: ParsedSelector): boolean {
  const matchesAt = (candidate: SelectableElement, index: number): boolean => {
    const step = parsed.steps[index] as Step;
    if (!matchesCompound(candidate, step.compound)) return false;
    if (index === 0) return true;
    const next = index - 1;
    if (step.combinator === 'child') {
      const parent = parentElement(candidate);
      return parent !== null && matchesAt(parent, next);
    }
    for (let up = parentElement(candidate); up !== null; up = parentElement(up)) {
      if (matchesAt(up, next)) return true;
    }
    return false;
  };
  return matchesAt(element, parsed.steps.length - 1);
}
