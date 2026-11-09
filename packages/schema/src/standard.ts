// Single responsibility: the Standard Schema v1 interface plus library-agnostic helpers.
// This is the swap point: every Ultimate primitive accepts any conforming schema, so ArkType,
// Zod and Valibot are all first-class without a line of adapter code.

import {
  IssueCapInvalidError,
  SchemaUnsupportedError,
  ValidationFailedError,
  type ValidationIssue,
} from './errors';
import {
  cappedFailure,
  type IssueCapOptions,
  issueCapFault,
  MAX_ISSUES,
  withIssueCap,
} from './issue-cap';
import { issueRuleFacts, type SchemaIssueParams } from './schema-rules';

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
  /**
   * Ultimate's extension: `true` when validation stopped at its issue cap (`MAX_ISSUES`, or
   * `validate(…, { maxIssues })`), so `issues` is a prefix of what is wrong, never all of it.
   */
  readonly issuesTruncated?: true | undefined;
}

export type StandardResult<Output> = StandardSuccessResult<Output> | StandardFailureResult;

export interface StandardPathSegment {
  readonly key: PropertyKey;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | StandardPathSegment)[] | undefined;
  /**
   * Ultimate's extension: which rule refused, from `SCHEMA_RULES` (`string.min`). Optional, since
   * a conforming library has none — a translator keys on it, never on the English `message`.
   */
  readonly rule?: string | undefined;
  /** The declared facts the rule names (`{ min: 3 }`), for the translator to interpolate. */
  readonly params?: SchemaIssueParams | undefined;
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

/**
 * Any issue list this package or its consumers produce, whatever shape the path takes —
 * a `StandardIssue`'s segment array, or an already-flattened dotted string.
 */
export interface FormattableIssue {
  readonly message: string;
  readonly path?: string | readonly (PropertyKey | StandardPathSegment)[] | undefined;
}

/**
 * The one issue-to-text renderer for the whole framework: `x_validation_failed`,
 * MCP arg errors and action input/output errors all read the same `path: message`
 * line so a human or an agent parses one format everywhere. Callers join or index
 * the array however their surface needs it.
 */
export function formatIssues(issues: readonly FormattableIssue[]): readonly string[] {
  return issues.map((issue) => {
    const path = typeof issue.path === 'string' ? issue.path : formatPath(issue.path);
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/** Normalise any conforming library's issues into Ultimate's path-annotated shape. */
export function toValidationIssues(issues: readonly StandardIssue[]): readonly ValidationIssue[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    expected: issue.message,
    received: '',
    message: issue.message,
    ...issueRuleFacts(issue),
  }));
}

/**
 * Async by the rule `await` itself uses — a callable `then` — never `instanceof Promise`. A
 * library's own promise class, a polyfill or a Promise from another realm fails that test, and was
 * then read as a RESULT: no `issues` key, so a success, with `value` undefined. `parse` returned
 * `undefined` for input nothing had validated.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function assertSync<Output>(
  result: StandardResult<Output> | Promise<StandardResult<Output>>,
  vendor: string,
): StandardResult<Output> {
  if (isThenable(result)) {
    throw new SchemaUnsupportedError({
      cause: `${vendor} validated asynchronously in a synchronous call site`,
      fix: 'call validateAsync()/parseAsync() instead of validate()/parse()',
      meta: { vendor },
    });
  }
  return result;
}

function capOf(options: IssueCapOptions | undefined): number {
  const max = options?.maxIssues;
  if (max === undefined) return MAX_ISSUES;
  const fault = issueCapFault(max);
  if (fault === undefined) return max;
  throw new IssueCapInvalidError({
    cause: `${fault}; got ${Number.isFinite(max) ? String(max) : typeof max}`,
    fix: 'validate(schema, value, { maxIssues: 100 })   # or omit maxIssues for the default MAX_ISSUES',
    meta: { maxIssues: max },
  });
}

/** A failure held to its cap; a success passes through untouched. */
function bounded<Output>(
  result: StandardResult<Output>,
  cap: number,
  stopped: boolean,
): StandardResult<Output> {
  if (result.issues === undefined) return result;
  return cappedFailure(result.issues, cap, stopped || result.issuesTruncated === true);
}

/**
 * Validate against ANY conforming schema. Never throws on invalid input. At most `maxIssues`
 * (default `MAX_ISSUES`) issues come back: a builtin schema STOPS checking there, so a hostile
 * 10k-item body costs a hundred refusals, not ten thousand; a foreign library's list is cut.
 */
export function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  options?: IssueCapOptions,
): StandardResult<InferOutput<S>> {
  const props = schema['~standard'];
  const run = withIssueCap(capOf(options), () => props.validate(value));
  const result = assertSync(run.value, props.vendor) as StandardResult<InferOutput<S>>;
  return bounded(result, run.cap, run.stopped);
}

export async function validateAsync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  options?: IssueCapOptions,
): Promise<StandardResult<InferOutput<S>>> {
  // The cap spans the SYNCHRONOUS part of the call — all of a builtin schema's work. A library
  // that validates asynchronously finishes outside it, and its list is cut below instead.
  const run = withIssueCap(capOf(options), () => schema['~standard'].validate(value));
  const result = (await run.value) as StandardResult<InferOutput<S>>;
  return bounded(result, run.cap, run.stopped);
}

/** Validate or throw `X_VALIDATION_FAILED` with a path-annotated issue list. */
export function parse<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  root = 'value',
): InferOutput<S> {
  const result = validate(schema, value);
  if (result.issues === undefined) return result.value;
  throw new ValidationFailedError(
    toValidationIssues(result.issues),
    root,
    result.issuesTruncated === true,
  );
}

export async function parseAsync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  root = 'value',
): Promise<InferOutput<S>> {
  const result = await validateAsync(schema, value);
  if (result.issues === undefined) return result.value;
  throw new ValidationFailedError(
    toValidationIssues(result.issues),
    root,
    result.issuesTruncated === true,
  );
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
