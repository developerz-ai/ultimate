// Single responsibility: the `Schema` type every builtin validator returns, and the factory
// that turns a check function plus an IR node into a Standard-Schema-conforming object.

import { describeValue } from './describe-value';
import { SchemaError, ValidationFailedError, type ValidationIssue } from './errors';
import type { SchemaNode, SchemaRefinement } from './node';
import {
  formatPath,
  type InferInput,
  type InferOutput,
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

export function fail(path: Path, message: string): CheckErr {
  return { ok: false, issues: [{ message, path: [...path] }] };
}

export function failWith(issues: readonly StandardIssue[]): CheckErr {
  return { ok: false, issues };
}

/** An object with own keys — not null, not an array. The gate every object-ish check opens with. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The default declaration, dropped — for a wrapper that can no longer reach it. */
function withoutDefault(node: SchemaNode): SchemaNode {
  const { hasDefault: _hasDefault, default: _default, ...rest } = node;
  return rest;
}

function toIssues(result: CheckErr): readonly ValidationIssue[] {
  return result.issues.map((issue) => ({
    path: formatPath(issue.path),
    expected: issue.message,
    received: '',
    message: issue.message,
  }));
}

export function makeSchema<In, Out>(node: SchemaNode, check: Check<Out>): Schema<In, Out> {
  const schema: Schema<In, Out> = {
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown): StandardResult<Out> => {
        const result = check(value, []);
        return result.ok ? { value: result.value } : { issues: result.issues };
      },
    },
    node,
    parse(value: unknown, root = 'value'): Out {
      const result = check(value, []);
      if (result.ok) return result.value;
      throw new ValidationFailedError(toIssues(result), root);
    },
    safeParse(value: unknown): StandardResult<Out> {
      const result = check(value, []);
      return result.ok ? { value: result.value } : { issues: result.issues };
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
            : fail([...path, ...(refinement.path ?? [])], refinement.message);
        },
      );
    },
  };
  return schema;
}

/** Read the check back off a builtin schema so composites can reuse it. */
export function checkOf<In, Out>(schema: Schema<In, Out>): Check<Out> {
  return (value, path) => {
    const result = schema['~standard'].validate(value);
    if (result instanceof Promise) {
      return fail(path, 'expected a synchronous schema, received an async one');
    }
    if (result.issues === undefined) return pass(result.value);
    return failWith(
      result.issues.map((issue) => ({
        message: issue.message,
        path: [...path, ...(issue.path ?? [])],
      })),
    );
  };
}
