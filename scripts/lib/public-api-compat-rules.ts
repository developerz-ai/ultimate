// The rules a changed interface, object type or parameter list is judged by — the input-or-output
// unknown case: a new optional member or trailing parameter, a parameter that accepts more (a wider
// union, a new optional property of an object literal) are compatible, and nothing else is.
// `public-api-compat.ts` dispatches to these by shape kind.

import type { ApiShape, MemberCode, ParamCode } from './public-api-shape';

export interface ApiSymbol {
  /** sha-256 (16 hex) of the normalised declaration. */
  readonly hash: string;
  /** Absent only in a format-1 lock, or an entry written before every declaration had a shape. */
  readonly shape?: ApiShape;
}

export type ApiChange =
  | { readonly kind: 'same' }
  | { readonly kind: 'compatible' | 'break'; readonly why: string };

export const breaks = (why: string): Exclude<ApiChange, { kind: 'same' }> => ({
  kind: 'break',
  why,
});

/** Own keys only: a member named `toString` is never `Object.prototype`'s. */
export const own = <T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined => (record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined);

export const optional = (code: string): boolean => code.startsWith('?');
export const bare = (code: string): string => code.replace(/^\?/, '');

/**
 * `inherited` is what the tree's `extends` ancestors declare: a required member re-declared exactly
 * as a parent already requires it asks nothing new of a caller. Only the parent's CURRENT text is
 * known — a parent is judged as its own symbol, never through its child.
 */
export function members(
  before: Readonly<Record<string, MemberCode>>,
  after: Readonly<Record<string, MemberCode>>,
  inherited: Readonly<Record<string, { readonly code: MemberCode; readonly from: string }>> = {},
): ApiChange {
  const added: string[] = [];
  const redeclared: string[] = [];
  for (const [name, was] of Object.entries(before)) {
    const now = own(after, name);
    const label = name.startsWith('#') ? 'an index or call signature' : `member \`${name}\``;
    if (now === undefined) return breaks(`${label} was removed`);
    if (optional(was) && !optional(now)) return breaks(`${label} became required`);
    if (!optional(was) && optional(now)) {
      return breaks(`${label} became optional, which code reading it does not expect`);
    }
    if (bare(was) !== bare(now)) return breaks(`${label} changed its type`);
  }
  for (const [name, now] of Object.entries(after)) {
    if (own(before, name) !== undefined) continue;
    if (name.startsWith('#')) return breaks('an index or call signature was added');
    const parent = own(inherited, name);
    if (parent !== undefined && parent.code === now) {
      redeclared.push(`\`${name}\` re-declared as its parent \`${parent.from}\` requires it`);
      continue;
    }
    if (!optional(now)) return breaks(`required member \`${name}\` was added`);
    added.push(name);
  }
  if (redeclared.length > 0) {
    const more =
      added.length === 0 ? '' : `; optional ${added.map((name) => `\`${name}\``).join(', ')} added`;
    return { kind: 'compatible', why: `${redeclared.join(', ')}${more}` };
  }
  return added.length === 0
    ? { kind: 'compatible', why: 'members reordered or re-spelt only' }
    : {
        kind: 'compatible',
        why: `optional ${added.map((name) => `\`${name}\``).join(', ')} added`,
      };
}

interface Param {
  readonly rest: boolean;
  readonly optional: boolean;
  readonly union: readonly string[];
  /** An object-literal type's members (`{a=code,b=?code}`); absent for any other type. */
  readonly object?: Readonly<Record<string, MemberCode>>;
}

function objectOf(type: string): Record<string, MemberCode> | undefined {
  if (!type.startsWith('{') || !type.endsWith('}')) return undefined;
  const body = type.slice(1, -1);
  const pairs = body === '' ? [] : body.split(',').map((pair) => pair.split('='));
  return Object.fromEntries(pairs.map(([name = '', code = '']) => [name, code]));
}

function param(code: ParamCode): Param {
  const rest = code.startsWith('...');
  const tail = rest ? code.slice(3) : code;
  const type = bare(tail);
  const object = objectOf(type);
  return {
    rest,
    optional: tail.startsWith('?'),
    union: type.split('|'),
    ...(object === undefined ? {} : { object }),
  };
}

/**
 * An object-literal parameter, judged as the input it is: what a caller passes must still be
 * accepted, so a new optional property is compatible and anything a passed object lacks is not.
 */
function objectParam(
  at: string,
  was: Param,
  now: Param,
): Exclude<ApiChange, { kind: 'same' }> | undefined {
  if (was.object === undefined || now.object === undefined) return undefined;
  for (const [name, code] of Object.entries(was.object)) {
    const next = own(now.object, name);
    if (next === undefined) return breaks(`${at} property \`${name}\` was removed`);
    if (bare(code) !== bare(next)) return breaks(`${at} property \`${name}\` changed its type`);
    if (optional(code) && !optional(next))
      return breaks(`${at} property \`${name}\` became required`);
  }
  for (const [name, code] of Object.entries(now.object)) {
    if (own(was.object, name) === undefined && !optional(code)) {
      return breaks(`${at} gained required property \`${name}\``);
    }
  }
  return { kind: 'compatible', why: `${at} accepts more properties` };
}

export function params(before: readonly ParamCode[], after: readonly ParamCode[]): ApiChange {
  const whys: string[] = [];
  if (after.length < before.length) return breaks(`parameter ${after.length + 1} was removed`);
  for (const [index, code] of after.entries()) {
    const now = param(code);
    const at = `parameter ${index + 1}`;
    const recorded = before[index];
    if (recorded === undefined) {
      if (!now.optional && !now.rest) return breaks(`required ${at} was added`);
      whys.push(`optional ${at} added`);
      continue;
    }
    const was = param(recorded);
    if (was.rest !== now.rest) return breaks(`${at} changed between rest and single`);
    if (was.optional && !now.optional) return breaks(`${at} became required`);
    if (!was.optional && now.optional) whys.push(`${at} became optional`);
    const object = objectParam(at, was, now);
    if (object?.kind === 'break') return object;
    if (object !== undefined) {
      if (JSON.stringify(was.object) !== JSON.stringify(now.object)) whys.push(object.why);
      continue;
    }
    const kept = was.union.every((one) => now.union.includes(one));
    if (!kept) return breaks(`${at} changed its type, or no longer accepts what it did`);
    if (now.union.length > was.union.length) whys.push(`${at} accepts more`);
  }
  return { kind: 'compatible', why: whys.length > 0 ? whys.join(', ') : 'parameters renamed only' };
}
