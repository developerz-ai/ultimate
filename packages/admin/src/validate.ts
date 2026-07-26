// Form input → the entity's own schema. The admin never writes a second set of rules: it
// calls the Standard Schema the entity already validates with, so a value the admin accepts
// is a value the action would accept.

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

interface StandardResult {
  readonly value?: unknown;
  readonly issues?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number | { readonly key: string | number })[];
  }[];
}

interface StandardSchema {
  readonly '~standard': {
    validate(value: unknown): StandardResult | Promise<StandardResult>;
  };
}

const isStandardSchema = (schema: unknown): schema is StandardSchema =>
  typeof schema === 'object' &&
  schema !== null &&
  '~standard' in schema &&
  typeof (schema as StandardSchema)['~standard']?.validate === 'function';

const pathOf = (
  path: readonly (string | number | { readonly key: string | number })[] | undefined,
): string =>
  (path ?? [])
    .map((part) => (typeof part === 'object' ? String(part.key) : String(part)))
    .join('.');

export type ValidationResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * An entity with no schema is accepted as-is: `x verify` fails on an entity without one, so
 * a missing schema here means a hand-written test fixture, not a production hole.
 */
export async function validateInput(
  schema: unknown,
  input: Readonly<Record<string, unknown>>,
): Promise<ValidationResult> {
  if (!isStandardSchema(schema)) return { ok: true, value: input };

  const result = await schema['~standard'].validate(input);
  if (result.issues !== undefined && result.issues.length > 0) {
    return {
      ok: false,
      issues: result.issues.map((issue) => ({
        path: pathOf(issue.path),
        message: issue.message,
      })),
    };
  }
  const value = result.value;
  return typeof value === 'object' && value !== null
    ? { ok: true, value: value as Readonly<Record<string, unknown>> }
    : { ok: true, value: input };
}
