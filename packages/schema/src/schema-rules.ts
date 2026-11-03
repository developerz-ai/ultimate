// Single responsibility: the closed vocabulary an issue's `rule` names, and the one reader that
// lifts `rule`/`params` off an issue nobody in this process built. A translator keys on these, so
// the values are contract like an `X_*` code: add one, never rename one.

/** Every rule a builtin validator refuses with, in declaration order. */
export const SCHEMA_RULES = /* @__PURE__ */ Object.freeze([
  'required',
  'type',
  'string.min',
  'string.max',
  'string.pattern',
  'string.format',
  'number.min',
  'number.max',
  'number.integer',
  'enum',
  'literal',
  'array.min',
  'array.max',
  'union',
  'record.key',
  'json',
  'money',
  'refine',
] as const);

export type SchemaRule = (typeof SCHEMA_RULES)[number];

/**
 * What a translator interpolates: `{ min: 3 }`, `{ format: 'uuid' }`. Scalars only, and only facts
 * the schema author declared — never the rejected value, for `describe-value.ts`'s reason.
 */
export type SchemaIssueParams = Readonly<Record<string, string | number>>;

/** The two members, as they ride beside `message` and `path`. Both absent for a foreign issue. */
export interface IssueRuleFacts {
  readonly rule?: string;
  readonly params?: SchemaIssueParams;
}

const isScalar = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/**
 * `rule` and `params` off an issue, member by member, never spread: the issue may be a foreign
 * library's or a wire document's. A non-string `rule` is dropped, and `params` travels only beside
 * a `rule` and only when EVERY value is a scalar — a partly-kept `params` is a sentence rendered
 * with a hole in it. Total: a getter that throws is an issue with neither. Small on purpose: it is
 * in every browser bundle that decodes a refusal.
 */
export function issueRuleFacts(issue: unknown): IssueRuleFacts {
  try {
    const { rule, params } = issue as { readonly rule?: unknown; readonly params?: unknown };
    if (typeof rule !== 'string' || rule === '') return {};
    // Object spread defines own properties, so a `__proto__` key stays a key.
    return typeof params === 'object' &&
      params !== null &&
      !Array.isArray(params) &&
      Object.values(params).every(isScalar)
      ? { rule, params: { ...(params as SchemaIssueParams) } }
      : { rule };
  } catch {
    return {};
  }
}
