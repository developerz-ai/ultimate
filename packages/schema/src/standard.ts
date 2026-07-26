// Single responsibility: the Standard Schema v1 interface plus library-agnostic helpers.
// This is the swap point: every Ultimate primitive accepts any conforming schema, so ArkType,
// Zod and Valibot are all first-class without a line of adapter code.

import { SchemaUnsupportedError, ValidationFailedError, type ValidationIssue } from './errors';

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input, Output> {
  readonly version: 1;
  /** Library name, e.g. `ultimate`, `arktype`, `zod`. */
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: StandardTypes<Input, Output> | undefined;
}

export interface StandardTypes<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export interface StandardSuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardFailureResult {
  readonly issues: readonly StandardIssue[];
}

export type StandardResult<Output> = StandardSuccessResult<Output> | StandardFailureResult;

export interface StandardPathSegment {
  readonly key: PropertyKey;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | StandardPathSegment)[] | undefined;
}

export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];

export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S['~standard']['types']
>['output'];

/** `['items', 0, 'price']` -> `items[0].price` */
export function formatPath(
  path: readonly (PropertyKey | StandardPathSegment)[] | undefined,
): string {
  if (path === undefined || path.length === 0) return '';
  let out = '';
  for (const segment of path) {
    const key = typeof segment === 'object' ? segment.key : segment;
    if (typeof key === 'number') {
      out += `[${key}]`;
    } else {
      out += out === '' ? String(key) : `.${String(key)}`;
    }
  }
  return out;
}

/** Normalise any conforming library's issues into Ultimate's path-annotated shape. */
export function toValidationIssues(issues: readonly StandardIssue[]): readonly ValidationIssue[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    expected: issue.message,
    received: '',
    message: issue.message,
  }));
}

function assertSync<Output>(
  result: StandardResult<Output> | Promise<StandardResult<Output>>,
  vendor: string,
): StandardResult<Output> {
  if (result instanceof Promise) {
    throw new SchemaUnsupportedError({
      cause: `${vendor} validated asynchronously in a synchronous call site`,
      fix: 'call validateAsync()/parseAsync() instead of validate()/parse()',
      meta: { vendor },
    });
  }
  return result;
}

/** Validate against ANY conforming schema. Never throws on invalid input. */
export function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): StandardResult<InferOutput<S>> {
  const props = schema['~standard'];
  return assertSync(props.validate(value), props.vendor) as StandardResult<InferOutput<S>>;
}

export async function validateAsync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardResult<InferOutput<S>>> {
  const result = await schema['~standard'].validate(value);
  return result as StandardResult<InferOutput<S>>;
}

/** Validate or throw `X_VALIDATION_FAILED` with a path-annotated issue list. */
export function parse<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  root = 'value',
): InferOutput<S> {
  const result = validate(schema, value);
  if (result.issues === undefined) return result.value;
  throw new ValidationFailedError(toValidationIssues(result.issues), root);
}

export async function parseAsync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  root = 'value',
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, value);
  if (result.issues === undefined) return result.value;
  throw new ValidationFailedError(toValidationIssues(result.issues), root);
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) return false;
  const props = (value as { '~standard': unknown })['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    (props as { version?: unknown }).version === 1 &&
    typeof (props as { validate?: unknown }).validate === 'function'
  );
}
