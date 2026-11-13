// Whether a changed declaration still compiles every caller the recorded one did. Compatible: a new
// optional member, a new optional trailing parameter, a parameter that accepts more (a union it
// takes widened, a required one made optional). Everything else is a break — and so is anything
// this cannot tell, since a symbol's position (input or output) is unknown outside a parameter.

import type { ApiShape, MemberCode, ParamCode } from './public-api-shape';

export interface ApiSymbol {
  /** sha-256 (16 hex) of the normalised declaration. */
  readonly hash: string;
  /** Absent for a kind with no shape (class, enum, union alias, overloads) or a format-1 lock. */
  readonly shape?: ApiShape;
}

export type ApiChange =
  | { readonly kind: 'same' }
  | { readonly kind: 'compatible' | 'break'; readonly why: string };

const breaks = (why: string): ApiChange => ({ kind: 'break', why });

/** Own keys only: a member named `toString` is never `Object.prototype`'s. */
export const own = <T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined => (record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined);

const optional = (code: string): boolean => code.startsWith('?');
const bare = (code: string): string => code.replace(/^\?/, '');

function members(
  before: Readonly<Record<string, MemberCode>>,
  after: Readonly<Record<string, MemberCode>>,
): ApiChange {
  const added: string[] = [];
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
    if (!optional(now)) return breaks(`required member \`${name}\` was added`);
    added.push(name);
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
}

function param(code: ParamCode): Param {
  const rest = code.startsWith('...');
  const tail = rest ? code.slice(3) : code;
  return { rest, optional: tail.startsWith('?'), union: bare(tail).split('|') };
}

function params(before: readonly ParamCode[], after: readonly ParamCode[]): ApiChange {
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
    const kept = was.union.every((one) => now.union.includes(one));
    if (!kept) return breaks(`${at} changed its type, or no longer accepts what it did`);
    if (now.union.length > was.union.length) whys.push(`${at} accepts more`);
  }
  return { kind: 'compatible', why: whys.length > 0 ? whys.join(', ') : 'parameters renamed only' };
}

/** `before` (the lock) against `after` (the tree). */
export function classify(before: ApiSymbol, after: ApiSymbol): ApiChange {
  if (before.hash === after.hash) return { kind: 'same' };
  const [was, now] = [before.shape, after.shape];
  if (was === undefined) {
    return breaks('its declaration changed, and the lock holds no shape to judge the change by');
  }
  if (now === undefined || was.kind !== now.kind) {
    return breaks('its declaration changed kind, or to one whose change cannot be judged');
  }
  if (was.head !== now.head) {
    return breaks('its heading changed — type parameters, `extends`, or a local type it names');
  }
  if (was.kind === 'members' && now.kind === 'members') return members(was.members, now.members);
  if (was.kind === 'function' && now.kind === 'function') {
    if (was.returns !== now.returns) return breaks('its return type changed');
    return params(was.params, now.params);
  }
  return breaks('its declaration changed');
}
