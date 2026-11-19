// Whether a changed declaration still compiles every caller the recorded one did, by shape kind.
// Interfaces and functions: `public-api-compat-rules.ts`. Output-only kinds — a literal set that
// only grew, a `const` object or a class instance that only gained members — are compatible; a
// `declaration` is judged by its own text and the shapes of its locals. The rest is a break.

import { timingSafeEqual } from '../../packages/core/src/timing-safe-equal';
import type { ApiChange, ApiSymbol } from './public-api-compat-rules';
import { bare, breaks, members, optional, own, params } from './public-api-compat-rules';
import type { ApiShape, MemberCode } from './public-api-shape';

export type { ApiChange, ApiSymbol } from './public-api-compat-rules';
export { own } from './public-api-compat-rules';

const compatible = (why: string): ApiChange => ({ kind: 'compatible', why });

/**
 * A set of literals (an error-code union, a capability tuple). Grown is compatible, by the rule
 * this repo ships every code and capability under: a value list is additive. The one caller that
 * notices is an exhaustive `switch` over it, which gains an unhandled case — stated in the why.
 */
function literals(was: readonly string[], now: readonly string[]): ApiChange {
  const removed = was.filter((one) => !now.includes(one)).length;
  if (removed > 0) return breaks(`${removed} literal(s) were removed from the set`);
  const added = now.length - was.length;
  return compatible(
    added === 0
      ? 'literals reordered only'
      : `${added} literal(s) added — an exhaustive switch over it gains a case`,
  );
}

/**
 * Members of something callers only READ — a `const`'s object type, a class instance: any new
 * member is compatible, required or not. Removed, retyped, or made optional is a break.
 */
function readOnly(
  was: Readonly<Record<string, MemberCode>>,
  now: Readonly<Record<string, MemberCode>>,
): ApiChange {
  for (const [name, code] of Object.entries(was)) {
    const next = own(now, name);
    if (next === undefined) return breaks(`member \`${name}\` was removed`);
    if (bare(code) !== bare(next)) return breaks(`member \`${name}\` changed its type`);
    if (!optional(code) && optional(next)) return breaks(`member \`${name}\` became optional`);
  }
  const added = Object.keys(now).filter((name) => own(was, name) === undefined);
  return compatible(
    added.length === 0
      ? 'members reordered or re-spelt only'
      : `${added.map((name) => `\`${name}\``).join(', ')} added to a value callers only read`,
  );
}

/** A class: its instance read-only, its constructor an input. `implements` of one is not expected. */
function classChange(
  was: Extract<ApiShape, { kind: 'class' }>,
  now: Extract<ApiShape, { kind: 'class' }>,
): ApiChange {
  const read = readOnly(was.members, now.members);
  if (read.kind === 'break') return read;
  if (was.ctor === undefined && now.ctor === undefined) return read;
  if (was.ctor === undefined || now.ctor === undefined) {
    return breaks('its constructor appeared, disappeared or became overloaded');
  }
  const made = params(was.ctor, now.ctor);
  if (made.kind === 'break') return breaks(`its constructor: ${made.why}`);
  return compatible(
    `${read.kind === 'compatible' ? read.why : 'members unchanged'}; constructor: ${made.kind === 'compatible' ? made.why : 'unchanged'}`,
  );
}

/** A declaration: its own text unchanged, and every local it names judged by its own shape. */
function declarationChange(
  was: Extract<ApiShape, { kind: 'declaration' }>,
  now: Extract<ApiShape, { kind: 'declaration' }>,
): ApiChange {
  if (was.keyword !== now.keyword || was.head !== now.head) {
    return breaks(
      `its ${was.keyword} declaration changed, and one of this form is judged by its text`,
    );
  }
  const whys: string[] = [];
  for (const [name, local] of Object.entries(was.locals ?? {})) {
    const next = own(now.locals, name);
    if (next === undefined) return breaks(`the local type \`${name}\` it names was removed`);
    const change = classify(local, next);
    if (change.kind === 'break')
      return breaks(`the local type \`${name}\` it names: ${change.why}`);
    if (change.kind === 'compatible') whys.push(`local \`${name}\`: ${change.why}`);
  }
  return compatible(whys.length > 0 ? whys.join('; ') : 'a local type it names re-spelt only');
}

type Signature = Extract<ApiShape, { kind: 'function' }>;

const sameHeading = (one: Signature, next: Signature): boolean =>
  next.head === one.head || next.constHead === one.head;

const signaturesOf = (shape: ApiShape | undefined): readonly Signature[] | undefined =>
  shape?.kind === 'function' ? [shape] : shape?.kind === 'overloads' ? shape.signatures : undefined;

/**
 * A function or overload set on either side, and one is a set: every recorded signature must still
 * be matched by a signature with its heading, accepting its every call (`params`), answering the
 * SAME return. "Assignable" cannot be read off a digest, so a widened return is a break, not a guess.
 */
function callShapes(was: ApiShape, now: ApiShape | undefined): ApiChange | undefined {
  if (was.kind !== 'overloads' && now?.kind !== 'overloads') return undefined;
  const [recorded, current] = [signaturesOf(was), signaturesOf(now)];
  if (recorded === undefined || current === undefined) return undefined;
  for (const one of recorded) {
    // The FIRST overload that accepts the call is the one TypeScript resolves it against: a wider
    // one put in front answers every existing call with its own return, whatever follows it.
    const first = current.find(
      (next) => sameHeading(one, next) && params(one.params, next.params).kind !== 'break',
    );
    if (first === undefined) {
      return breaks(
        'the recorded call shape matches no overload with the same return — closest: no overload accepts it',
      );
    }
    if (first.returns === one.returns) continue;
    const later = current.slice(current.indexOf(first) + 1);
    const shadowed = later.some(
      (next) =>
        sameHeading(one, next) &&
        next.returns === one.returns &&
        params(one.params, next.params).kind !== 'break',
    );
    return breaks(
      shadowed
        ? 'the recorded call shape is answered first by an overload with another return'
        : 'the recorded call shape matches no overload with the same return — closest: its return type changed',
    );
  }
  return compatible('every recorded call shape still matches an overload with the same return');
}

/** `before` (the lock) against `after` (the tree). */
export function classify(before: ApiSymbol, after: ApiSymbol): ApiChange {
  if (timingSafeEqual(before.hash, after.hash)) return { kind: 'same' };
  const [was, now] = [before.shape, after.shape];
  if (was === undefined || was.kind === 'unrecorded') {
    return breaks('its declaration changed, and the lock holds no shape to judge the change by');
  }
  const calls = callShapes(was, now);
  if (calls !== undefined) return calls;
  if (now === undefined || now.kind === 'unrecorded' || was.kind !== now.kind) {
    return breaks('its declaration changed kind, or to one whose change cannot be judged');
  }
  if (was.kind === 'declaration' && now.kind === 'declaration') return declarationChange(was, now);
  if (was.kind === 'overloads' || now.kind === 'overloads')
    return breaks('its declaration changed');
  if (now.kind === 'declaration' || was.head !== now.head) {
    return breaks('its heading changed — type parameters, `extends`, or a local type it names');
  }
  if (was.kind === 'members' && now.kind === 'members') {
    return members(was.members, now.members, now.inherited);
  }
  if (was.kind === 'function' && now.kind === 'function') {
    if (was.returns !== now.returns) return breaks('its return type changed');
    // Either side read from a `type … = (…) =>` alias: judged as something an app implements.
    return params(was.params, now.params, was.implemented === true || now.implemented === true);
  }
  if (was.kind === 'literals' && now.kind === 'literals') return literals(was.values, now.values);
  if (was.kind === 'value' && now.kind === 'value') return readOnly(was.members, now.members);
  if (was.kind === 'class' && now.kind === 'class') return classChange(was, now);
  return breaks('its declaration changed');
}
