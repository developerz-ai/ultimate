// Validation goes through the Standard Schema interface, never through a vendor
// API, so `t` is the schema layer's shipped default rather than a dependency of the HTTP layer.
import type { StandardSchemaV1 } from '@ultimat3/schema';

export type Schema<Out = unknown> = StandardSchemaV1<unknown, Out>;

export type InferOutput<S> = S extends Schema<infer Out> ? Out : never;

export type ValidationOutcome<Out> =
  | { readonly ok: true; readonly value: Out }
  | { readonly ok: false; readonly issues: readonly string[] };

type Issue = { readonly message: string; readonly path?: readonly unknown[] | undefined };

const segment = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null && 'key' in value) {
    return String((value as { key: unknown }).key);
  }
  return '?';
};

/** `posts.0.title: must be a string` — a path an agent can act on directly. */
export const formatIssue = (issue: Issue): string => {
  const path = (issue.path ?? []).map(segment).join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
};

/** A refusal still owes its reader a sentence, and a degenerate result gave none. */
const NO_ISSUES_REPORTED = 'the schema reported a failure with no issues';

/**
 * A Standard Schema result is discriminated by the PRESENCE of `issues`, never by its length: a
 * success result declares `issues?: undefined` and a failure result carries no `value` at all. A
 * length test read `issues: []` as success and returned `value: undefined as Out` — an `undefined`
 * the caller's types say cannot happen, which surfaced one frame later as a `TypeError` and a 500
 * for a request that was simply invalid.
 */
const outcome = <Out>(result: {
  readonly value?: Out;
  readonly issues?: readonly Issue[] | undefined;
}): ValidationOutcome<Out> => {
  if (result.issues !== undefined) {
    const issues = result.issues.map(formatIssue);
    return { ok: false, issues: issues.length > 0 ? issues : [NO_ISSUES_REPORTED] };
  }
  return { ok: true, value: result.value as Out };
};

/**
 * Query strings and route params must validate without awaiting: they are read
 * inside synchronous stages. A schema that returns a promise here is a bug in the
 * schema, not in the request.
 */
export const validateSync = <Out>(schema: Schema<Out>, value: unknown): ValidationOutcome<Out> => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    return { ok: false, issues: ['schema is async; use validate() for request bodies'] };
  }
  return outcome<Out>(result);
};

export const validate = async <Out>(
  schema: Schema<Out>,
  value: unknown,
): Promise<ValidationOutcome<Out>> => outcome<Out>(await schema['~standard'].validate(value));
