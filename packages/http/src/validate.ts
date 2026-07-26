// Validation goes through the Standard Schema interface, never through a vendor
// API, so ArkType (`t`) is a default rather than a dependency of the HTTP layer.
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

const outcome = <Out>(result: {
  readonly value?: Out;
  readonly issues?: readonly Issue[] | undefined;
}): ValidationOutcome<Out> => {
  if (result.issues !== undefined && result.issues.length > 0) {
    return { ok: false, issues: result.issues.map(formatIssue) };
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
