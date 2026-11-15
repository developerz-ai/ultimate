// A normalised declaration read into the structure a change is classified by: an interface's or
// object type's members, a function's parameters and return type, and the kinds in
// `public-api-shape-kinds.ts`. Every declaration has a shape: one this cannot read structurally is
// a `declaration` — its own text, and the shapes of the local types it names.

import { tokenize } from './public-api-dts';
import type { ApiShape, LocalShape } from './public-api-shape-kinds';
import { classOf, constObjectOf, literalsOf } from './public-api-shape-kinds';
import {
  closing,
  membersOf,
  paramOf,
  shortDigest,
  splitAt,
  topLevel,
} from './public-api-shape-words';

export type { ApiShape, LocalShape } from './public-api-shape-kinds';
export type { MemberCode, ParamCode } from './public-api-shape-words';
export { shortDigest } from './public-api-shape-words';

/** `head ( params ) <arrow> returns` → a function shape, when `open` starts the parameter list. */
function functionOf(
  words: readonly string[],
  open: number,
  arrow: string,
  locals: string,
): ApiShape | undefined {
  const close = closing(words, open);
  if (close === -1 || words[close + 1] !== arrow || close + 2 >= words.length) return undefined;
  return {
    kind: 'function',
    head: shortDigest([words.slice(0, open).join(' '), locals].join('\n')),
    params: splitAt(words.slice(open + 1, close), ',').map(paramOf),
    returns: shortDigest(words.slice(close + 2).join(' ')),
  };
}

/** The `{` opening a type alias's trailing object literal: `= {` or `= A & {`. */
function trailingObject(words: readonly string[], from: number): number {
  if (words[from] === '{') return from;
  if (words.at(-1) !== '}') return -1;
  let depth = 0;
  for (let at = words.length - 1; at > from; at -= 1) {
    const word = words[at] ?? '';
    if (word === '}' || word === ')' || word === ']' || word === '>') depth += 1;
    else if (word === '{' || word === '(' || word === '[' || word === '<') depth -= 1;
    if (depth === 0) return words[at - 1] === '&' && topLevel(words, '|', from) === -1 ? at : -1;
  }
  return -1;
}

function structural(words: readonly string[], localLines: readonly string[]): ApiShape | undefined {
  const locals = localLines.join('\n');
  const [keyword] = words;
  if (keyword === 'interface' || keyword === 'type') {
    const literal = keyword === 'type' ? literalsOf(words, localLines) : undefined;
    if (literal !== undefined) return literal;
    const from = keyword === 'type' ? topLevel(words, '=', 2) + 1 : 2;
    if (keyword === 'type' && from > 0 && (words[from] === '(' || words[from] === '<')) {
      // `type F = ( … ) => R` and `type F = < T > ( … ) => R`: a function type is a function.
      const open = words[from] === '<' ? closing(words, from) + 1 : from;
      const shape = words[open] === '(' ? functionOf(words, open, '=>', locals) : undefined;
      return shape?.kind === 'function' ? { ...shape, implemented: true } : shape;
    }
    const open = keyword === 'type' ? trailingObject(words, from) : topLevel(words, '{', 2);
    if (from === 0 || open === -1 || words[open] !== '{') return undefined;
    if (closing(words, open) !== words.length - 1) return undefined;
    return {
      kind: 'members',
      head: shortDigest([words.slice(0, open).join(' '), locals].join('\n')),
      members: membersOf(words.slice(open + 1, -1)),
    };
  }
  if (keyword === 'function') return functionOf(words, topLevel(words, '(', 2), ':', locals);
  if (keyword === 'class' || keyword === 'abstract') return classOf(words, locals);
  if (keyword === 'const' && words[2] === ':') {
    const shaped = literalsOf(words, localLines) ?? constObjectOf(words, locals);
    if (shaped !== undefined) return shaped;
    const open = words[3] === '<' ? closing(words, 3) + 1 : 3;
    if (words[open] !== '(') return undefined;
    return functionOf(words, open, '=>', locals);
  }
  return undefined;
}

/** A `local …` line's name: the word after its keyword (`local interface X …`, `local const X`). */
const localName = (line: string): string => {
  const words = line.split(' ');
  return (words[1] === 'declare' || words[1] === 'abstract' ? words[3] : words[2]) ?? '';
};

/** Each local, by name, as its own text's digest and shape. */
function localShapes(lines: readonly string[]): Record<string, LocalShape> {
  const out = new Map<string, string[]>();
  for (const line of lines) out.set(localName(line), [...(out.get(localName(line)) ?? []), line]);
  return Object.fromEntries(
    [...out].map(([name, texts]) => {
      const text = texts.map((one) => one.slice('local '.length)).join('\n');
      const shape = texts.length === 1 ? structural(tokenize(text), []) : undefined;
      const hash = shortDigest(text);
      return [name, shape === undefined ? { hash } : { hash, shape }];
    }),
  );
}

/**
 * The shape of one symbol's text as `symbolReader` builds it: its own declaration(s), then any
 * `local …` lines. Overloads, merged declarations, enums, namespaces and every type this cannot
 * read structurally are a `declaration`, keyed by the first word.
 */
export function shapeOf(text: string): ApiShape {
  const lines = text.split('\n');
  const localLines = lines.filter((line) => line.startsWith('local '));
  const parents = lines.filter((line) => line.startsWith('inherits '));
  const own = lines.filter((line) => !line.startsWith('local ') && !line.startsWith('inherits '));
  if (own.length === 1) {
    const shaped = structural(tokenize(own[0] ?? ''), localLines);
    if (shaped?.kind === 'members' && parents.length > 0) {
      return { ...shaped, inherited: inheritedOf(parents) };
    }
    if (shaped !== undefined) return shaped;
  }
  const signatures = own.map((line) => structural(tokenize(line), localLines));
  if (own.length > 1 && signatures.every((one) => one?.kind === 'function')) {
    return { kind: 'overloads', signatures: signatures.filter((one) => one?.kind === 'function') };
  }
  const first = (own[0] ?? '').split(' ')[0] ?? '';
  const keyword =
    own.length > 1 ? `overloaded ${first}` : /^\w+=/.test(first) ? 'namespace' : first;
  const locals = localShapes(localLines);
  return {
    kind: 'declaration',
    keyword,
    head: shortDigest(own.join('\n')),
    ...(Object.keys(locals).length === 0 ? {} : { locals }),
  };
}

/** Each `inherits interface P … { … }` line's members, the nearest ancestor's code first. */
function inheritedOf(
  parents: readonly string[],
): Record<string, { readonly code: string; readonly from: string }> {
  const out = new Map<string, { readonly code: string; readonly from: string }>();
  for (const line of parents) {
    const words = tokenize(line.slice('inherits '.length));
    const open = topLevel(words, '{', 2);
    if (words[0] !== 'interface' || open === -1) continue;
    const from = words[1] ?? '';
    for (const [name, code] of Object.entries(membersOf(words.slice(open + 1, -1)))) {
      if (!out.has(name)) out.set(name, { code, from });
    }
  }
  return Object.fromEntries(out);
}
