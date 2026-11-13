// A normalised declaration read into the structure a change is classified by: an interface's or
// object type's members (name → optionality + type digest), a function's parameters (optionality,
// rest, the digests of its type's union members) and return type. Anything else has no shape and
// is judged by its hash alone — any change to it is a break.

import { tokenize } from './public-api-dts';

/** `?` optional, then the member's text (name and `?` removed) as an 8-hex digest. */
export type MemberCode = string;
/** `...` rest, `?` optional, then the parameter type's union-member digests joined by `|`. */
export type ParamCode = string;

export type ApiShape =
  | {
      readonly kind: 'members';
      /** The heading (`interface X<T> extends Y`, `type X =`) and every local type it names. */
      readonly head: string;
      readonly members: Readonly<Record<string, MemberCode>>;
    }
  | {
      readonly kind: 'function';
      /** The name, the type parameters and every local type the signature names. */
      readonly head: string;
      readonly params: readonly ParamCode[];
      readonly returns: string;
    };

export const shortDigest = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 8);

const OPEN = new Set(['{', '(', '[', '<']);
const CLOSE = new Set(['}', ')', ']', '>']);

/** The index of the bracket closing the one at `open`, or -1. */
function closing(words: readonly string[], open: number): number {
  let depth = 0;
  for (let at = open; at < words.length; at += 1) {
    if (OPEN.has(words[at] ?? '')) depth += 1;
    else if (CLOSE.has(words[at] ?? '')) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** `words` split at every depth-0 `separator`; empty parts dropped. */
function splitAt(words: readonly string[], separator: string): string[][] {
  const parts: string[][] = [];
  let part: string[] = [];
  let depth = 0;
  for (const word of words) {
    if (word === separator && depth === 0) {
      if (part.length > 0) parts.push(part);
      part = [];
      continue;
    }
    if (OPEN.has(word)) depth += 1;
    else if (CLOSE.has(word)) depth -= 1;
    part.push(word);
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

const MODIFIER = new Set(['readonly', 'get', 'set']);
const NAME = /^(?:[\w$]+|"[^"\\]*")$/;
const FOLLOWS_NAME = new Set(['?', ':', '(', '<']);

/** One member of a body: its key (`#<digest>` for an index or call signature) and its code. */
function memberOf(words: readonly string[]): readonly [string, MemberCode] {
  let at = 0;
  while (MODIFIER.has(words[at] ?? '') && !FOLLOWS_NAME.has(words[at + 1] ?? '')) at += 1;
  const name = words[at] ?? '';
  if (!NAME.test(name) || !FOLLOWS_NAME.has(words[at + 1] ?? '')) {
    return [`#${shortDigest(words.join(' '))}`, shortDigest(words.join(' '))];
  }
  const optional = words[at + 1] === '?';
  const rest = words.filter((_, index) => index !== at && !(optional && index === at + 1));
  const key = /^"[\w$]+"$/.test(name) ? name.slice(1, -1) : name;
  return [key, `${optional ? '?' : ''}${shortDigest(rest.join(' '))}`];
}

/** A body's members; overloads and accessor pairs under one key, optional only if all are. */
function membersOf(body: readonly string[]): Record<string, MemberCode> {
  const grouped = new Map<string, MemberCode[]>();
  for (const member of splitAt(body, ';')) {
    const [key, code] = memberOf(member);
    grouped.set(key, [...(grouped.get(key) ?? []), code]);
  }
  // `fromEntries` defines each key as its own: a member named `__proto__` stays a member.
  return Object.fromEntries(
    [...grouped].map(([key, codes]) => {
      if (codes.length === 1) return [key, codes[0] ?? ''];
      const optional = codes.every((code) => code.startsWith('?'));
      return [key, `${optional ? '?' : ''}${shortDigest(codes.join(','))}`];
    }),
  );
}

/** Splitting at `|` is sound only where no arrow, conditional or `extends` binds looser than it. */
const UNSPLITTABLE = new Set(['=>', '?', 'extends']);

/** A type's union members, digested and sorted: a set, so reordering a union changes nothing. */
function unionOf(words: readonly string[]): string[] {
  let depth = 0;
  for (const word of words) {
    if (OPEN.has(word)) depth += 1;
    else if (CLOSE.has(word)) depth -= 1;
    else if (depth === 0 && UNSPLITTABLE.has(word)) return [shortDigest(words.join(' '))];
  }
  const parts = splitAt(words, '|').map((part) => shortDigest(part.join(' ')));
  return [...new Set(parts)].sort();
}

function paramOf(words: readonly string[]): ParamCode {
  const rest = words[0] === '...';
  const named = rest ? words.slice(1) : words;
  const colon = splitAt(named, ':');
  const [binding = [], ...typed] = colon;
  if (typed.length === 0) return `${rest ? '...' : ''}${shortDigest(named.join(' '))}`;
  const optional = binding.at(-1) === '?';
  const type = named.slice(binding.length + 1);
  return `${rest ? '...' : ''}${optional ? '?' : ''}${unionOf(type).join('|')}`;
}

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

/** The first depth-0 `word` at or after `from`. */
function topLevel(words: readonly string[], word: string, from: number): number {
  let depth = 0;
  for (let at = from; at < words.length; at += 1) {
    const one = words[at] ?? '';
    if (one === word && depth === 0) return at;
    if (OPEN.has(one)) depth += 1;
    else if (CLOSE.has(one)) depth -= 1;
  }
  return -1;
}

function shapeOfDeclaration(words: readonly string[], locals: string): ApiShape | undefined {
  const [keyword] = words;
  if (keyword === 'interface' || keyword === 'type') {
    const from = keyword === 'type' ? topLevel(words, '=', 2) + 1 : 2;
    const open = keyword === 'type' ? from : topLevel(words, '{', 2);
    if (from === 0 || open === -1 || words[open] !== '{') return undefined;
    if (closing(words, open) !== words.length - 1) return undefined;
    return {
      kind: 'members',
      head: shortDigest([words.slice(0, open).join(' '), locals].join('\n')),
      members: membersOf(words.slice(open + 1, -1)),
    };
  }
  if (keyword === 'function') return functionOf(words, topLevel(words, '(', 2), ':', locals);
  if (keyword === 'const' && words[2] === ':') {
    const open = words[3] === '<' ? closing(words, 3) + 1 : 3;
    if (words[open] !== '(') return undefined;
    return functionOf(words, open, '=>', locals);
  }
  return undefined;
}

/**
 * The shape of one symbol's text as `symbolReader` builds it: a single declaration, then any
 * `local …` lines. Two own declarations (overloads, a merged interface and const) have none.
 */
export function shapeOf(text: string): ApiShape | undefined {
  const [own = '', ...rest] = text.split('\n');
  if (rest.some((line) => !line.startsWith('local '))) return undefined;
  return shapeOfDeclaration(tokenize(own), rest.join('\n'));
}
