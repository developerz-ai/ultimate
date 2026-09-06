// Which of an error's `meta` keys a problem document may carry, per code — and the copy of them
// that leaves the process. Split from `error-map.ts` (457 lines against the 500-line ceiling) and
// kept beside it in shape: `registerErrorStatus` is the app's declaration of the HTTP half of a
// code, and this is the second half of the same declaration, written in the same file of the app.
//
// OPT-IN, PER KEY, BY CODE — never "carry `meta`". `meta` is the framework's OPERATOR-ONLY bag
// and four packages depend on it never reaching a caller: `bodyInvalid` puts the fragment of the
// body the parser choked on there (a `{"password": …}` excerpt, once), the rate limiter puts the
// internal key it promoted an anonymous caller to, core's `assert` puts the rejected VALUE, and
// `env-example.ts` puts file paths. A blanket carry would have shipped every one of them to the
// network tab. So an app names the keys, for the codes it owns, and everything else stays where
// it was. Measured need: an app's `X_SESSION_CHECKOUT_BUSY` carried `{ sessionId, title, state }`
// in `meta` and its island recovered the id by running a UUID regex over `cause`.

import { ERROR_STATUS } from './error-map';
import { problemMetaInvalid } from './errors';

/** What a problem document's `meta` member holds — JSON, and nothing JSON cannot carry. */
export type ProblemMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly ProblemMetaValue[]
  | { readonly [key: string]: ProblemMetaValue };

export type ProblemMeta = Readonly<Record<string, ProblemMetaValue>>;

/**
 * The serialised ceiling, in bytes, of what a document carries under `meta`. A problem body is a
 * refusal, not a payload: `MAX_PROBLEM_ISSUES` bounds the other extension for the same reason.
 * Over the cap the member is dropped WHOLE, never cut — a subset of keys is a claim the server
 * never made, and a client reading `meta.sessionId` off a document that dropped `sessionId` to
 * make room has no way to tell "absent" from "cut".
 */
export const MAX_PROBLEM_META_BYTES = 4096;

/**
 * A key is spelled the way a code's `meta` key is spelled in source. `issues` is refused by name
 * because it already has a top-level home (`ProblemDocument.issues`, parsed and bounded on its
 * own terms), and a second copy under `meta.issues` is two places for a client to read one fact.
 * `__proto__` is refused because `JSON.parse` on the receiving side mints it as a real own key.
 */
const KEY = /^[A-Za-z_$][\w$]*$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set(['issues', '__proto__']);

/** Per app-owned code, the `meta` keys its documents carry. A `Map`, for `APP_ERROR_STATUS`'s reason. */
const DECLARED = new Map<string, readonly string[]>();

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, at) => key === right[at]);

/**
 * Declare, per code, which `meta` keys the problem document carries. Call it once at boot, in
 * the module that declares the codes — beside `registerErrorStatus`, and BOTH are needed: a code
 * with no declared status is an unclassified 5xx, and `toProblem` blanks everything but the code
 * and the request id on one of those, `meta` included.
 *
 * ```ts
 * registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
 * registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId', 'title', 'state'] });
 * ```
 *
 * Framework-owned codes are refused, exactly as `registerErrorStatus` refuses them: their `meta`
 * is where the framework keeps what a caller must not be handed, and an app that could declare
 * `X_RATE_LIMITED: ['key']` would publish the limiter's internal key on every 429.
 */
export const registerProblemMeta = (
  declarations: Readonly<Record<string, readonly string[]>>,
): void => {
  for (const [code, keys] of Object.entries(declarations)) {
    if (frameworkOwns(code)) {
      throw problemMetaInvalid(code, 'the framework owns that code, and its meta is operator-only');
    }
    if (keys.length === 0) {
      throw problemMetaInvalid(code, 'the key list is empty — omit the code instead');
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !KEY.test(key)) {
        throw problemMetaInvalid(code, `${JSON.stringify(key)} is not a meta key`);
      }
      if (RESERVED_KEYS.has(key)) {
        throw problemMetaInvalid(
          code,
          key === 'issues'
            ? '`issues` already rides at the top level of the document'
            : `\`${key}\` is not a key a document may carry`,
        );
      }
    }
    const existing = DECLARED.get(code);
    if (existing !== undefined && !sameKeys(existing, keys)) {
      throw problemMetaInvalid(code, `already declared as [${existing.join(', ')}] by this app`);
    }
    DECLARED.set(code, [...keys]);
  }
};

/** Test seam. Production registers once at boot and never unregisters. */
export const resetProblemMeta = (): void => DECLARED.clear();

/** The keys declared for a code, or `undefined` when nothing was — which is every framework code. */
export const problemMetaKeysFor = (code: string): readonly string[] | undefined =>
  DECLARED.get(code);

/**
 * A code this package's table maps is the framework's. A `Set` of the table's own keys, for the
 * reason `frameworkStatus` reads that table through `Object.hasOwn`: it is an object literal,
 * and `registerProblemMeta({ toString: [...] })` must not find a function in it.
 */
const FRAMEWORK_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_STATUS));
const frameworkOwns = (code: string): boolean => FRAMEWORK_CODES.has(code);

/**
 * The declared keys of `meta`, copied member by member into a fresh document, or `undefined`.
 *
 * TOTAL — `meta` is a property read on a value this package did not build, in the frame that
 * decides what the caller sees (`retryAfterOf`'s reason). ALL-OR-NOTHING, for `issuesOf`'s
 * reason: a document carrying `sessionId` and silently missing `state` is a claim the server
 * never made. So one value JSON cannot carry — a function, a `bigint`, a `Date`, a class
 * instance, a non-finite number, a cycle — drops the WHOLE member, and so does a serialisation
 * past `MAX_PROBLEM_META_BYTES`. A structural walk and never a `JSON.stringify` round trip: the
 * round trip drops a function and an `undefined` SILENTLY, which is the footgun rather than the
 * check (`@ultimat3/render`'s `island-props.ts` walks for the same reason).
 *
 * ABSENT when nothing survives — never `{}`. `{}` says "the server declared meta and had none",
 * which a client cannot tell from "the server carries no meta for this code".
 */
export function wireMeta(source: unknown, keys: readonly string[]): ProblemMeta | undefined {
  try {
    if (typeof source !== 'object' || source === null) return undefined;
    const meta = source as Record<string, unknown>;
    const out: Record<string, ProblemMetaValue> = {};
    let carried = 0;
    for (const key of keys) {
      if (!Object.hasOwn(meta, key)) continue;
      const value = jsonSafe(meta[key], new Set());
      if (value === MISSING) return undefined;
      define(out, key, value);
      carried += 1;
    }
    if (carried === 0) return undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(out)).byteLength;
    return bytes > MAX_PROBLEM_META_BYTES ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The one value the walk cannot answer with, distinct from the `null` JSON can carry. */
const MISSING: unique symbol = Symbol('problem-meta.missing');

/**
 * A plain own data property, whatever the name: `out[key] = value` for the one name `__proto__`
 * runs `Object.prototype`'s setter instead of adding a key. `registerProblemMeta` refuses that
 * name at the top level; a NESTED object off the error is walked here with the same care, and
 * the key is skipped outright — the receiving `JSON.parse` would mint it as an own key again.
 */
function define(out: Record<string, ProblemMetaValue>, key: string, value: ProblemMetaValue): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

function jsonSafe(value: unknown, seen: Set<object>): ProblemMetaValue | typeof MISSING {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : MISSING;
  if (typeof value !== 'object') return MISSING;
  if (seen.has(value)) return MISSING;
  seen.add(value);
  let out: ProblemMetaValue | typeof MISSING = MISSING;
  if (Array.isArray(value)) {
    const items: ProblemMetaValue[] = [];
    for (const item of value as readonly unknown[]) {
      const safe = jsonSafe(item, seen);
      if (safe === MISSING) return MISSING;
      items.push(safe);
    }
    out = items;
  } else if (isPlainObject(value)) {
    const record: Record<string, ProblemMetaValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__') continue;
      const safe = jsonSafe(item, seen);
      if (safe === MISSING) return MISSING;
      define(record, key, safe);
    }
    out = record;
  }
  seen.delete(value);
  return out;
}

/** A `Date`, a `Map`, an error, a class instance: each serialises to something other than itself. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
