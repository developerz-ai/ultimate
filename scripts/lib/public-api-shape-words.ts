// The token walking every shape kind shares: matching brackets, depth-0 splits, a body's members
// and a parameter's code. Split from `public-api-shape.ts` so the kinds in
// `public-api-shape-kinds.ts` read declarations with the same rules, and neither imports the other.

/** `?` optional, then the member's text (name and `?` removed) as an 8-hex digest. */
export type MemberCode = string;
/**
 * `...` rest, `?` optional, then the type: its union-member digests joined by `|`, or — for a
 * type that is one object literal — `{` and its members (`name=code`, sorted, `,`-joined) `}`.
 */
export type ParamCode = string;

export const shortDigest = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 8);

export const OPEN = new Set(['{', '(', '[', '<']);
export const CLOSE = new Set(['}', ')', ']', '>']);

/** The index of the bracket closing the one at `open`, or -1. */
export function closing(words: readonly string[], open: number): number {
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
export function splitAt(words: readonly string[], separator: string): string[][] {
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

/** The first depth-0 `word` at or after `from`. */
export function topLevel(words: readonly string[], word: string, from: number): number {
  let depth = 0;
  for (let at = from; at < words.length; at += 1) {
    const one = words[at] ?? '';
    if (one === word && depth === 0) return at;
    if (OPEN.has(one)) depth += 1;
    else if (CLOSE.has(one)) depth -= 1;
  }
  return -1;
}

const MODIFIER = new Set(['readonly', 'get', 'set']);
const NAME = /^(?:[\w$]+|"[^"\\]*")$/;
// `=`: a class property's initialiser in a `.d.ts` (`static readonly code = "X"`).
const FOLLOWS_NAME = new Set(['?', ':', '(', '<', '=']);

/** One member of a body: its key (`#<digest>` for an index or call signature) and its code. */
export function memberOf(words: readonly string[]): readonly [string, MemberCode] {
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

/** Members, overloads and accessor pairs under one key, optional only if all are. */
export function groupMembers(
  members: readonly (readonly [string, MemberCode])[],
): Record<string, MemberCode> {
  const grouped = new Map<string, MemberCode[]>();
  for (const [key, code] of members) grouped.set(key, [...(grouped.get(key) ?? []), code]);
  // `fromEntries` defines each key as its own: a member named `__proto__` stays a member.
  return Object.fromEntries(
    [...grouped].map(([key, codes]) => {
      if (codes.length === 1) return [key, codes[0] ?? ''];
      const optional = codes.every((code) => code.startsWith('?'));
      return [key, `${optional ? '?' : ''}${shortDigest(codes.join(','))}`];
    }),
  );
}

/** A body's members. */
export const membersOf = (body: readonly string[]): Record<string, MemberCode> =>
  groupMembers(splitAt(body, ';').map(memberOf));

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

/** `{ name=code,… }` for a type that is exactly one object literal; else its union digests. */
function typeCode(words: readonly string[]): string {
  if (words[0] !== '{' || closing(words, 0) !== words.length - 1) return unionOf(words).join('|');
  const members = Object.entries(membersOf(words.slice(1, -1))).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${members.map(([name, code]) => `${name}=${code}`).join(',')}}`;
}

export function paramOf(words: readonly string[]): ParamCode {
  const rest = words[0] === '...';
  const named = rest ? words.slice(1) : words;
  const colon = splitAt(named, ':');
  const [binding = [], ...typed] = colon;
  if (typed.length === 0) return `${rest ? '...' : ''}${shortDigest(named.join(' '))}`;
  const optional = binding.at(-1) === '?';
  const type = named.slice(binding.length + 1);
  return `${rest ? '...' : ''}${optional ? '?' : ''}${typeCode(type)}`;
}
