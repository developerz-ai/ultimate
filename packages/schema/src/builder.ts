// Single responsibility: the `Schema` type every builtin validator returns, and the factory
// that turns a check function plus an IR node into a Standard-Schema-conforming object.

import { describeValue } from './describe-value';
import {
  DefaultInvalidError,
  SchemaError,
  ValidationFailedError,
  type ValidationIssue,
} from './errors';
import { cappedFailure, MAX_ISSUES, withIssueCap } from './issue-cap';
import type { SchemaNode, SchemaRefinement } from './node';
import { issueRuleFacts, type SchemaIssueParams, type SchemaRule } from './schema-rules';
import {
  formatIssues,
  formatPath,
  type InferInput,
  type InferOutput,
  isThenable,
  type StandardIssue,
  type StandardResult,
  type StandardSchemaV1,
} from './standard';

export const VENDOR = 'ultimate';

export type Path = readonly PropertyKey[];

export interface CheckOk<Out> {
  readonly ok: true;
  readonly value: Out;
}

export interface CheckErr {
  readonly ok: false;
  readonly issues: readonly StandardIssue[];
}

export type CheckResult<Out> = CheckOk<Out> | CheckErr;

export type Check<Out> = (value: unknown, path: Path) => CheckResult<Out>;

export function pass<Out>(value: Out): CheckOk<Out> {
  return { ok: true, value };
}

/**
 * The PROVIDER's refusal: `rule` and `params` optional, because a library backing `t` may have no
 * name for its rule. A builtin validator never calls this — it calls `rejected`, whose `rule` is
 * required, so a builtin refusal a translator cannot key on is a type error (`schema-rules.test.ts`
 * pins that no builtin file reaches for `fail`).
 */
export function fail(
  path: Path,
  message: string,
  rule?: string,
  params?: SchemaIssueParams,
): CheckErr {
  return {
    ok: false,
    issues: [
      {
        message,
        path: [...path],
        ...(rule === undefined ? {} : { rule }),
        ...(params === undefined ? {} : { params }),
      },
    ],
  };
}

/** Package-internal: a builtin's refusal, naming its rule from the closed `SCHEMA_RULES`. */
export function rejected(
  path: Path,
  message: string,
  rule: SchemaRule,
  params?: SchemaIssueParams,
): CheckErr {
  return fail(path, message, rule, params);
}

/** The wrong kind of value: `required` when nothing was sent, `type` naming what was wanted. */
export function mistyped(path: Path, message: string, value: unknown, type: string): CheckErr {
  return value === undefined
    ? rejected(path, message, 'required')
    : rejected(path, message, 'type', { type });
}

export function failWith(issues: readonly StandardIssue[]): CheckErr {
  return { ok: false, issues };
}

/**
 * A record of own keys: an object literal, or a null-prototype one (what this package's own
 * object and record parsers answer). The gate every object-ish check opens with.
 *
 * The PROTOTYPE is the test, not "an object that is not an array": a `Map`, a `Date` and a class
 * instance are all that, and each has no own enumerable keys the schema declared — so
 * `t.record(t.number)` parsed a `Map` of anything to `{}` and an all-optional `t.object` parsed a
 * `Date` to `{}`, a success carrying none of what was sent.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A rule the IR cannot state structurally — `endDate > startDate`, `total === sum(lines)`. It
 * lives on the schema rather than in a handler so it reaches OpenAPI, the MCP tool schema, the
 * typed client and the form binding from the one declaration, like every other constraint.
 *
 * `message` is authored by the developer and rendered verbatim, so it must state the RULE and
 * never the value — see `describe-value.ts` for why an issue message is a public surface.
 */
export interface Refinement<Out> {
  /** Stable machine id, kebab-case: `end-after-start`. Projected as `x-ultimate-refinements`. */
  readonly name: string;
  /** The rule as a sentence, e.g. `endDate must be after startDate`. Never interpolate a value. */
  readonly message: string;
  /** Runs on the PARSED output, so a cross-field rule compares coerced values, not raw input. */
  readonly check: (value: Out) => boolean;
  /** Which field the issue is reported against. Absent reports it against the object itself. */
  readonly path?: readonly string[] | undefined;
}

export interface Schema<In = unknown, Out = In> extends StandardSchemaV1<In, Out> {
  /** The introspectable IR. JSON Schema, OpenAPI, MCP and coercion all read this. */
  readonly node: SchemaNode;
  parse(value: unknown, root?: string): Out;
  safeParse(value: unknown): StandardResult<Out>;
  optional(): Schema<In | undefined, Out | undefined>;
  /**
   * Distinct from `optional()`: absent and null are different facts. A nullable column holds a
   * row that says "no cover image"; an optional field says the caller did not mention it. SQL
   * has always drawn that line, so the schema has to as well or a round-trip loses it.
   */
  nullable(): Schema<In | null, Out | null>;
  default(value: Out): Schema<In | undefined, Out>;
  describe(description: string): Schema<In, Out>;
  /**
   * Sent in, never written down, never sent back. The audit record and `x jobs show` mask it, it
   * publishes as `writeOnly`, and an output that reaches it is `X_SCHEMA_SENSITIVE_OUTPUT`. NOT the
   * app's own log lines — a `logger.info('x', input)` holds no schema; that stays `redactKeys`.
   */
  sensitive(): Schema<In, Out>;
  /**
   * Attach a cross-field rule. Returns a plain `Schema` on purpose — `extend`/`pick`/`omit`
   * rebuild from the shape and would silently drop the refinement, so refining last is a type
   * error to get wrong rather than a comment asking you not to.
   */
  refine(refinement: Refinement<Out>): Schema<In, Out>;
}

/** The general constraint for "some schema". Methods are bivariant, so this is a real supertype. */
export type AnySchema = Schema<unknown, unknown>;

export type Shape = Readonly<Record<string, AnySchema>>;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type OptionalOutputKeys<S extends Shape> = {
  [K in keyof S]: undefined extends InferOutput<S[K]> ? K : never;
}[keyof S];

type OptionalInputKeys<S extends Shape> = {
  [K in keyof S]: undefined extends InferInput<S[K]> ? K : never;
}[keyof S];

export type ShapeOutput<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalOutputKeys<S>>]: InferOutput<S[K]> } & {
    [K in OptionalOutputKeys<S>]?: InferOutput<S[K]>;
  }
>;

export type ShapeInput<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalInputKeys<S>>]: InferInput<S[K]> } & {
    [K in OptionalInputKeys<S>]?: InferInput<S[K]>;
  }
>;

/**
 * One FRESH copy of a default per parse. `.default([])` handed every parse the same array, so a
 * handler pushing onto it made that push the next request's starting value for the life of the
 * process — cross-request data bleed declared in a schema.
 *
 * Primitives are immutable, so they are still shared and cost nothing. Everything else is decided
 * ONCE, here at declaration: a value `structuredClone` can copy is copied per parse, and one it
 * cannot is refused at the first import of the authoring file — the same "wrong for every input,
 * so say so where it is written" rule `X_SCHEMA_DISCRIMINANT_INVALID` follows. What that refuses
 * was never a working declaration: `node.default` is published as JSON, so a default carrying a
 * function or a symbol could not reach OpenAPI either.
 *
 * Known narrow cost: a class instance clones to a plain object, so a default that relied on its
 * prototype loses it. Schema defaults are wire values, which is the only thing `node.default` can
 * publish, so that shape was already outside what a default may mean.
 */
function defaultFactory<Out>(fallback: Out): () => Out {
  if (fallback === null || typeof fallback !== 'object') return () => fallback;
  try {
    structuredClone(fallback);
  } catch {
    throw new SchemaError({
      code: 'X_SCHEMA_DEFAULT_UNSHAREABLE',
      cause: `default() received ${describeValue(fallback)}, which structuredClone cannot copy`,
      fix: 'pass a JSON-shaped default (plain object, array, Date, Map, Set), or drop .default() and answer the absent value in the handler',
    });
  }
  return () => structuredClone(fallback);
}

/**
 * A fallback the schema itself refuses, refused where it is WRITTEN. `t.number.min(5).default(1)`
 * parsed an omitted field to 1 — a value the same schema rejects when a caller sends it — and
 * published `minimum: 5, default: 1` to every generated client. Wrong for every parse that omits
 * the field, so the first import of the authoring file says so, as `defaultFactory` does.
 */
function assertDefaultValid<Out>(check: Check<Out>, fallback: Out): void {
  const result = check(fallback, []);
  if (result.ok) return;
  throw new DefaultInvalidError({
    // The issue text is the RULE (`describeValue` never echoes content), so quoting it is safe.
    cause: `default() received ${describeValue(fallback)}, which this schema refuses — ${formatIssues(result.issues).join('; ')}`,
    fix: 'edit the .default(…) named in the stack so its value satisfies the rule quoted in cause, or relax that rule on the schema',
  });
}

/** The default declaration, dropped — for a wrapper that can no longer reach it. */
function withoutDefault(node: SchemaNode): SchemaNode {
  const { hasDefault: _hasDefault, default: _default, ...rest } = node;
  return rest;
}

function toIssues(issues: readonly StandardIssue[]): readonly ValidationIssue[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    expected: issue.message,
    received: '',
    message: issue.message,
    ...issueRuleFacts(issue),
  }));
}

/**
 * One whole validation: the check under the issue cap (`issue-cap.ts`), its failure held to it.
 * Every door into a builtin schema goes through here, so none of them is unbounded — a nested
 * call (a composite reading a member through `checkOf`) joins its caller's cap.
 */
function capped<Out>(check: Check<Out>, value: unknown): StandardResult<Out> {
  const run = withIssueCap(MAX_ISSUES, () => check(value, []));
  return run.value.ok
    ? { value: run.value.value }
    : cappedFailure(run.value.issues, run.cap, run.stopped);
}

/**
 * A builtin schema's check, keyed by its `'~standard'` object — the one part every spread
 * (`{ ...base, min }`) keeps by reference. A composite reads a builtin member through this, never
 * through the public `validate`: that door costs a cap closure, a run record, a result and a
 * re-wrap per member even when the member passes (`standard.perf.test.ts`).
 */
const BUILTIN_CHECKS = new WeakMap<object, Check<unknown>>();

export function makeSchema<In, Out>(node: SchemaNode, check: Check<Out>): Schema<In, Out> {
  const props: Schema<In, Out>['~standard'] = {
    version: 1,
    vendor: VENDOR,
    validate: (value: unknown): StandardResult<Out> => capped(check, value),
  };
  BUILTIN_CHECKS.set(props, check as Check<unknown>);
  const schema: Schema<In, Out> = {
    '~standard': props,
    node,
    parse(value: unknown, root = 'value'): Out {
      const result = capped(check, value);
      if (result.issues === undefined) return result.value;
      throw new ValidationFailedError(
        toIssues(result.issues),
        root,
        result.issuesTruncated === true,
      );
    },
    safeParse(value: unknown): StandardResult<Out> {
      return capped(check, value);
    },
    optional(): Schema<In | undefined, Out | undefined> {
      return makeSchema<In | undefined, Out | undefined>(
        // `.default(x).optional()` published `default: x` while `parse` answered `undefined`:
        // this wrapper short-circuits `undefined` before the default is ever reached, so a client
        // honouring the published default assumed a value the server never produced.
        withoutDefault({ ...node, optional: true }),
        (value, path) => (value === undefined ? pass(undefined) : check(value, path)),
      );
    },
    nullable(): Schema<In | null, Out | null> {
      return makeSchema<In | null, Out | null>({ ...node, nullable: true }, (value, path) =>
        value === null ? pass(null) : check(value, path),
      );
    },
    default(fallback: Out): Schema<In | undefined, Out> {
      // Rule before copy: a refused fallback has to be replaced, so its clone problem is moot.
      assertDefaultValid(check, fallback);
      const fresh = defaultFactory(fallback);
      return makeSchema<In | undefined, Out>(
        // The node keeps the DECLARATION, never a copy: `node.default` is what OpenAPI, the MCP
        // tool schema and the typed client publish, and they describe what was written.
        { ...node, hasDefault: true, default: fallback },
        (value, path) => (value === undefined ? pass(fresh()) : check(value, path)),
      );
    },
    describe(description: string): Schema<In, Out> {
      return makeSchema<In, Out>({ ...node, description }, check);
    },
    sensitive(): Schema<In, Out> {
      return makeSchema<In, Out>({ ...node, sensitive: true }, check);
    },
    refine(refinement: Refinement<Out>): Schema<In, Out> {
      const declared: SchemaRefinement = {
        name: refinement.name,
        message: refinement.message,
        ...(refinement.path === undefined ? {} : { path: [...refinement.path] }),
      };
      return makeSchema<In, Out>(
        { ...node, refinements: [...(node.refinements ?? []), declared] },
        (value, path) => {
          // Shape first: a predicate written against `Out` must never be handed an unparsed
          // value, or every refinement grows a defensive typeof the schema already performed.
          const result = check(value, path);
          if (!result.ok) return result;
          return refinement.check(result.value)
            ? result
            : rejected([...path, ...(refinement.path ?? [])], refinement.message, 'refine', {
                name: refinement.name,
              });
        },
      );
    },
  };
  return schema;
}

/**
 * Read the check back off a schema so composites can reuse it. A builtin schema answers its own
 * check, joining the caller's issue cap directly; a foreign Standard Schema member keeps the
 * public route, its issues re-rooted under the caller's path.
 */
export function checkOf<In, Out>(schema: Schema<In, Out>): Check<Out> {
  const builtin = BUILTIN_CHECKS.get(schema['~standard']);
  if (builtin !== undefined) return builtin as Check<Out>;
  return (value, path) => {
    const result = schema['~standard'].validate(value);
    if (isThenable(result)) {
      // A provider fault, not a rule a value broke: no `rule`, so a form falls back to the text.
      return fail(path, 'expected a synchronous schema, received an async one');
    }
    if (result.issues === undefined) return pass(result.value);
    return failWith(
      result.issues.map((issue) => ({
        message: issue.message,
        path: [...path, ...(issue.path ?? [])],
        // A composite re-roots a member's issues; the rule that refused rides along unchanged.
        ...issueRuleFacts(issue),
      })),
    );
  };
}

/** The path a composite hands a member: shared, never written to, so a pass allocates none. */
const MEMBER_ROOT: Path = Object.freeze([]);

/**
 * A composite's member at `key` under `path`. The member runs at a shared empty path and its
 * issues are re-rooted only when it fails, so a passing member costs no path array; order and
 * count are the member's own, so the issue cap and issue order are untouched.
 */
export function checkAt<Out>(
  check: Check<Out>,
  value: unknown,
  path: Path,
  key: PropertyKey,
): CheckResult<Out> {
  const result = check(value, MEMBER_ROOT);
  if (result.ok) return result;
  return failWith(
    result.issues.map((issue) => ({ ...issue, path: [...path, key, ...(issue.path ?? [])] })),
  );
}
