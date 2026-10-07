// Every spelling of "this module re-exports a value it imported from another module": the parser
// half of `package-reexports.ts`, with no opinion on WHICH values count — the caller says, so the
// entry scan (`package-entries.ts`) and the rule share one reading of the source.

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';

/** Whether `name`, imported from module `from`, is a value this scan is looking for. */
export type IsValue = (from: string, name: string) => boolean;

export interface Reexport {
  /** The value's own name in `from`, or `*` for the whole namespace. */
  readonly name: string;
  /** The name it is published under. */
  readonly alias: string;
  /** The module specifier it was imported from. */
  readonly from: string;
  readonly index: number;
}

const SPEC = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/;

interface Spec {
  readonly local: string;
  readonly alias: string;
  readonly offset: number;
}

/** The value specifiers of a `{ … }` list starting at `start` — `type x` dropped. */
function valueSpecs(list: string, start: number): readonly Spec[] {
  const specs: Spec[] = [];
  for (const part of list.matchAll(/[^,]+/g)) {
    const spec = SPEC.exec(part[0]);
    if (spec === null || spec[1] !== undefined || spec[2] === undefined) continue;
    const offset = start + part.index + part[0].indexOf(spec[2]);
    specs.push({ local: spec[2], alias: spec[3] ?? spec[2], offset });
  }
  return specs;
}

/** The module specifier whose opening quote ends `match`, read from the comment-stripped view. */
const specifierOf = (stripped: string, match: RegExpMatchArray): string => {
  const quote = (match.index ?? 0) + match[0].length - 1;
  const end = stripped.indexOf(stripped[quote] as string, quote + 1);
  return end < 0 ? '' : stripped.slice(quote + 1, end);
};

const RE_EXPORT = /\bexport\s*\{([^}]*)\}\s*from\s*['"]/g;
const NAMED_IMPORT = /\bimport\s*(type\s+)?\{([^}]*)\}\s*from\s*['"]/g;
const NAMESPACE_IMPORT = /\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*['"]/g;
const LOCAL_EXPORT = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
/**
 * `[export] const y[: T] = x[.member] [as T | satisfies T];` — the same value under a second name.
 * Exported, it IS the re-export; unexported, it is the first half of `const h = x; export { h }`.
 * The annotation is lazy and the `=` may not be part of `=>`, so `const f: () => T = x` parses.
 */
const ALIAS_BINDING =
  /\b(export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^;]*?)?(?<![=!<>])=(?![=>])\s*([\w$]+)(?:\s*\.\s*([\w$]+))?(?:\s+(?:as|satisfies)\s+[^;]+?)?\s*;/g;

interface Binding {
  readonly name: string;
  readonly from: string;
}

/**
 * Structure is read from the MASKED view, so a scaffold template that writes a re-export into a
 * generated app is a string and not a re-export; each specifier, a string, from the stripped view
 * at the same offset.
 */
export function reexportsIn(text: string, isValue: IsValue): readonly Reexport[] {
  const masked = maskLiterals(text);
  const stripped = stripComments(text);
  const hits: Reexport[] = [];
  const brace = (match: RegExpMatchArray): number => (match.index ?? 0) + match[0].indexOf('{') + 1;

  for (const match of masked.matchAll(RE_EXPORT)) {
    const from = specifierOf(stripped, match);
    for (const spec of valueSpecs(match[1] ?? '', brace(match))) {
      if (isValue(from, spec.local))
        hits.push({ name: spec.local, alias: spec.alias, from, index: spec.offset });
    }
  }

  // Local bindings of wanted values: `import { x as y }` binds `y` to `from`'s `x`.
  const bound = new Map<string, Binding>();
  const namespaces = new Map<string, string>();
  for (const match of masked.matchAll(NAMED_IMPORT)) {
    if (match[1] !== undefined) continue;
    const from = specifierOf(stripped, match);
    for (const spec of valueSpecs(match[2] ?? '', brace(match))) {
      if (isValue(from, spec.local)) bound.set(spec.alias, { name: spec.local, from });
    }
  }
  for (const match of masked.matchAll(NAMESPACE_IMPORT)) {
    const from = specifierOf(stripped, match);
    if (match[1] !== undefined && isValue(from, '*')) namespaces.set(match[1], from);
  }
  if (bound.size === 0 && namespaces.size === 0) return hits;

  // In source order, so `const a = x; const b = a;` binds `b` to `x` too.
  for (const match of masked.matchAll(ALIAS_BINDING)) {
    const [, exported, alias = '', head = '', member] = match;
    const space = namespaces.get(head);
    const binding =
      member === undefined
        ? bound.get(head)
        : space !== undefined && isValue(space, member)
          ? { name: member, from: space }
          : undefined;
    if (binding === undefined) continue;
    if (exported === undefined) bound.set(alias, binding);
    else hits.push({ ...binding, alias, index: match.index ?? 0 });
  }

  for (const match of masked.matchAll(LOCAL_EXPORT)) {
    for (const spec of valueSpecs(match[1] ?? '', brace(match))) {
      const space = namespaces.get(spec.local);
      const binding = space === undefined ? bound.get(spec.local) : { name: '*', from: space };
      if (binding !== undefined) hits.push({ ...binding, alias: spec.alias, index: spec.offset });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
