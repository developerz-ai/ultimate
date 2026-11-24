// The shape kinds beyond an interface and a function: a literal set (a literal union, `keyof
// typeof` a local object, a readonly tuple of literals), a value (a `const` typed as an object),
// a class (members and constructor), overloads, and every other declaration as its own text plus
// the shapes of the local types it names — so a change confined to one local is judged by that local.

import type { MemberCode, ParamCode } from './public-api-shape-words';
import {
  closing,
  groupMembers,
  memberOf,
  membersOf,
  paramOf,
  shortDigest,
  splitAt,
  topLevel,
} from './public-api-shape-words';

/** A local type's own record: its text's digest and, when it has one, its shape. */
export interface LocalShape {
  readonly hash: string;
  readonly shape?: ApiShape;
}

export type ApiShape =
  | {
      readonly kind: 'members';
      /** The heading (`interface X<T> extends Y`, `type X =`) and every local type it names. */
      readonly head: string;
      readonly members: Readonly<Record<string, MemberCode>>;
      /**
       * What its `extends` ancestors declare, member → code and the parent's name. The tree's side
       * only: never written to the lock, read to tell a re-declared member from a new one.
       */
      readonly inherited?: Readonly<
        Record<string, { readonly code: MemberCode; readonly from: string }>
      >;
    }
  | {
      /** One name, several signatures: each judged as a function. */
      readonly kind: 'overloads';
      readonly signatures: readonly Extract<ApiShape, { kind: 'function' }>[];
    }
  | {
      readonly kind: 'function';
      /** The name, the type parameters and every local type the signature names. */
      readonly head: string;
      /**
       * An overload's heading as `const name :` would spell it: an arrow const that gains an
       * overload must become a `function`, and the calls it accepted are the same calls.
       */
      readonly constHead?: string;
      readonly params: readonly ParamCode[];
      readonly returns: string;
      /**
       * Read from a `type F = (…) => R` alias: a callback an app may IMPLEMENT, so its parameters
       * may not accept more. The tree's side only — the lock's `shapeBody` never writes it.
       */
      readonly implemented?: true;
    }
  | {
      readonly kind: 'literals';
      readonly head: string;
      /** Each literal's digest, sorted: a set. */
      readonly values: readonly string[];
    }
  | {
      /** A `const` typed as an object literal: read, never assigned — an output. */
      readonly kind: 'value';
      readonly head: string;
      readonly members: Readonly<Record<string, MemberCode>>;
    }
  | {
      readonly kind: 'class';
      readonly head: string;
      /** Instance and `static ` members; private ones are no caller's. */
      readonly members: Readonly<Record<string, MemberCode>>;
      /** The one declared constructor's parameters; absent when it declares none or several. */
      readonly ctor?: readonly ParamCode[];
      /**
       * A single-signature method's codes with its trailing optional parameters dropped, one by one:
       * what it was if those were added since. The tree's side only — `shapeBody` never writes it.
       */
      readonly shorter?: Readonly<Record<string, readonly MemberCode[]>>;
    }
  | {
      /** Anything else: judged by its own text, and by the shapes of the locals it names. */
      readonly kind: 'declaration';
      readonly keyword: string;
      readonly head: string;
      readonly locals?: Readonly<Record<string, LocalShape>>;
      /**
       * A `namespace` (`import * as X` re-exported): each export's name and the digest of its text.
       * A module object is only read, so an export added to it is compatible, not a changed text.
       */
      readonly exports?: Readonly<Record<string, string>>;
    }
  | {
      /** A held lock entry no release tag reproduced: the lock knows its hash and nothing else. */
      readonly kind: 'unrecorded';
    };

const LITERAL = /^(?:"(?:[^"\\]|\\.)*"|\d[\w.]*)$/;

/** Each part a literal (`"a"`, `1`, `- 1`), as its text; `undefined` if one is not. */
function literalsIn(parts: readonly (readonly string[])[]): string[] | undefined {
  const out: string[] = [];
  for (const part of parts) {
    const text = part.join(' ');
    const bare = part[0] === '-' && part.length === 2 ? (part[1] ?? '') : text;
    if (part.length > 2 || !LITERAL.test(bare)) return undefined;
    out.push(text);
  }
  return out.length === 0 ? undefined : out;
}

const set = (values: readonly string[]): string[] => [...new Set(values.map(shortDigest))].sort();

/** The keys of `local const <name> : { … }` among `locals`, or `undefined`. */
function localObjectKeys(locals: readonly string[], name: string): string[] | undefined {
  for (const line of locals) {
    const words = line.split(' ').slice(1);
    if (words[0] !== 'const' || words[1] !== name || words[2] !== ':' || words[3] !== '{') continue;
    if (closing(words, 3) !== words.length - 1) return undefined;
    return Object.keys(membersOf(words.slice(4, -1)));
  }
  return undefined;
}

/** `type X = "a" | "b"` · `type X = keyof typeof L` · `const X : readonly [ "a" , "b" ]`. */
export function literalsOf(
  words: readonly string[],
  locals: readonly string[],
): ApiShape | undefined {
  if (words[0] === 'type') {
    const from = topLevel(words, '=', 2) + 1;
    if (from === 0) return undefined;
    const body = words.slice(from);
    const head = shortDigest(words.slice(0, from).join(' '));
    if (body.length === 3 && body[0] === 'keyof' && body[1] === 'typeof') {
      const keys = localObjectKeys(locals, body[2] ?? '');
      return keys === undefined
        ? undefined
        : { kind: 'literals', head: shortDigest(words.join(' ')), values: set(keys) };
    }
    const values = literalsIn(splitAt(body, '|'));
    return values === undefined ? undefined : { kind: 'literals', head, values: set(values) };
  }
  if (words[0] === 'const' && words[2] === ':' && words[3] === 'readonly' && words[4] === '[') {
    if (closing(words, 4) !== words.length - 1) return undefined;
    const values = literalsIn(splitAt(words.slice(5, -1), ','));
    if (values === undefined) return undefined;
    return {
      kind: 'literals',
      head: shortDigest(words.slice(0, 4).join(' ')),
      values: set(values),
    };
  }
  return undefined;
}

/** `const X : { … }`, its locals folded into the heading as an interface's are. */
export function constObjectOf(words: readonly string[], locals: string): ApiShape | undefined {
  if (words[0] !== 'const' || words[2] !== ':' || words[3] !== '{') return undefined;
  if (closing(words, 3) !== words.length - 1) return undefined;
  return {
    kind: 'value',
    head: shortDigest([words.slice(0, 3).join(' '), locals].join('\n')),
    members: membersOf(words.slice(4, -1)),
  };
}

const ACCESS = new Set(['static', 'protected', 'abstract']);

/** `name ( … ) : R` / `name ? < T > ( … ) : R` → the codes it has without each optional tail. */
function withoutOptionalTail(rest: readonly string[]): MemberCode[] {
  let open = rest[1] === '?' ? 2 : 1;
  if (rest[open] === '<') open = closing(rest, open) + 1;
  const close = rest[open] === '(' ? closing(rest, open) : -1;
  if (close === -1) return [];
  const params = splitAt(rest.slice(open + 1, close), ',');
  const codes: MemberCode[] = [];
  for (let keep = params.length - 1; keep >= 0; keep -= 1) {
    if (!paramOf(params[keep] ?? []).startsWith('?')) break;
    const kept = params.slice(0, keep).flatMap((param, at) => (at === 0 ? param : [',', ...param]));
    codes.push(memberOf([...rest.slice(0, open + 1), ...kept, ...rest.slice(close)])[1]);
  }
  return codes;
}

/** `class X … { … }`: members keyed `static x` / `x`, private dropped, the constructor apart. */
export function classOf(words: readonly string[], locals: string): ApiShape | undefined {
  const at = words[0] === 'abstract' ? 1 : 0;
  if (words[at] !== 'class') return undefined;
  const open = topLevel(words, '{', at + 2);
  if (open === -1 || closing(words, open) !== words.length - 1) return undefined;
  const members: (readonly [string, MemberCode])[] = [];
  const ctors: ParamCode[][] = [];
  const shorter = new Map<string, MemberCode[]>();
  for (const member of splitAt(words.slice(open + 1, -1), ';')) {
    const prefix = member.filter((word, index) => index < 3 && ACCESS.has(word));
    const rest = member.slice(prefix.length);
    if (rest[0] === 'private' || rest[0]?.startsWith('#')) continue;
    if (rest[0] === 'constructor' && rest[1] === '(') {
      ctors.push(splitAt(rest.slice(2, closing(rest, 1)), ',').map(paramOf));
      continue;
    }
    const [key, code] = memberOf(rest);
    const name = prefix.includes('static') ? `static ${key}` : key;
    // An overload set's code is all of its signatures: no one shorter form is what it was.
    shorter.set(name, members.some(([one]) => one === name) ? [] : withoutOptionalTail(rest));
    members.push([name, code]);
  }
  const [ctor] = ctors;
  const methods = [...shorter].filter(([, codes]) => codes.length > 0);
  return {
    kind: 'class',
    head: shortDigest([words.slice(0, open).join(' '), locals].join('\n')),
    members: groupMembers(members),
    ...(ctors.length === 1 && ctor !== undefined ? { ctor } : {}),
    ...(methods.length === 0 ? {} : { shorter: Object.fromEntries(methods) }),
  };
}
