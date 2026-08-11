// Single responsibility: typed environment validation at boot. Every missing or malformed key
// is reported in ONE error — an agent should never have to restart the process six times to
// discover six missing variables.

import { EnvMissingError } from './errors';
import { REDACTED, redactKeys } from './logger';
import { type Role, resolveRole } from './roles';

export type EnvVarType = 'string' | 'url' | 'number' | 'integer' | 'port' | 'boolean' | 'enum';

interface EnvVarCommon {
  /**
   * Omit for a required variable (the default). `required: false` is the only accepted
   * loosening — there is one way to say "optional".
   */
  readonly required?: false | undefined;
  /** Redacted in logs and masked in `x env check --json`. */
  readonly secret?: boolean | undefined;
  /** Only required when the process runs as one of these roles. */
  readonly role?: Role | readonly Role[] | undefined;
  readonly description?: string | undefined;
  /** Overrides the generic fix line for this key. */
  readonly fix?: string | undefined;
}

export interface EnvStringVar extends EnvVarCommon {
  readonly type: 'string' | 'url';
  readonly default?: string | undefined;
  readonly pattern?: RegExp | undefined;
}

export interface EnvNumberVar extends EnvVarCommon {
  readonly type: 'number' | 'integer' | 'port';
  readonly default?: number | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

export interface EnvBooleanVar extends EnvVarCommon {
  readonly type: 'boolean';
  readonly default?: boolean | undefined;
}

export interface EnvEnumVar<V extends string = string> extends EnvVarCommon {
  readonly type: 'enum';
  readonly values: readonly V[];
  readonly default?: V | undefined;
}

export type EnvVarDecl = EnvStringVar | EnvNumberVar | EnvBooleanVar | EnvEnumVar;

export type EnvSchema = Readonly<Record<string, EnvVarDecl>>;

type EnvVarValue<D> = D extends { readonly type: 'enum'; readonly values: readonly (infer V)[] }
  ? V
  : D extends { readonly type: 'number' | 'integer' | 'port' }
    ? number
    : D extends { readonly type: 'boolean' }
      ? boolean
      : string;

type EnvVarOptional<D> = D extends { readonly default: unknown }
  ? false
  : D extends { readonly role: unknown }
    ? true
    : D extends { readonly required: false }
      ? true
      : false;

export type Env<S extends EnvSchema> = {
  readonly [K in keyof S]: EnvVarOptional<S[K]> extends true
    ? EnvVarValue<S[K]> | undefined
    : EnvVarValue<S[K]>;
};

export interface EnvIssue {
  readonly key: string;
  readonly reason: 'missing' | 'invalid';
  readonly expected: string;
  /** Masked when the declaration is `secret: true`. */
  readonly received: string | undefined;
  readonly fix: string;
}

export interface EnvCheckReport {
  readonly ok: boolean;
  readonly issues: readonly EnvIssue[];
  readonly values: Readonly<Record<string, unknown>>;
}

export interface EnvOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly role?: Role | undefined;
  /** Register `secret: true` keys with the logger's redaction list. Default `true`. */
  readonly redact?: boolean | undefined;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function requiredForRole(decl: EnvVarDecl, role: Role): boolean {
  if (decl.required === false) return false;
  if (decl.role === undefined) return true;
  return typeof decl.role === 'string' ? decl.role === role : decl.role.includes(role);
}

function expectation(decl: EnvVarDecl): string {
  switch (decl.type) {
    case 'enum':
      return `one of ${decl.values.join(' | ')}`;
    case 'port':
      return 'an integer port 1-65535';
    case 'integer':
      return 'an integer';
    case 'number':
      return 'a number';
    case 'boolean':
      return `one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(' | ')}`;
    case 'url':
      return 'an absolute URL';
    default:
      return 'a non-empty string';
  }
}

function parseValue(decl: EnvVarDecl, raw: string): { ok: true; value: unknown } | { ok: false } {
  switch (decl.type) {
    case 'boolean': {
      const lowered = raw.toLowerCase();
      if (TRUE_VALUES.has(lowered)) return { ok: true, value: true };
      if (FALSE_VALUES.has(lowered)) return { ok: true, value: false };
      return { ok: false };
    }
    case 'number':
    case 'integer':
    case 'port': {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false };
      if (decl.type !== 'number' && !Number.isInteger(value)) return { ok: false };
      if (decl.type === 'port' && (value < 1 || value > 65535)) return { ok: false };
      if (decl.min !== undefined && value < decl.min) return { ok: false };
      if (decl.max !== undefined && value > decl.max) return { ok: false };
      return { ok: true, value };
    }
    case 'enum':
      return (decl.values as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false };
    case 'url':
      return URL.canParse(raw) ? { ok: true, value: raw } : { ok: false };
    default:
      if (decl.pattern !== undefined && !decl.pattern.test(raw)) return { ok: false };
      return { ok: true, value: raw };
  }
}

/** Validate without throwing — this is what `x env check --json` prints. */
export function checkEnv(schema: EnvSchema, options?: EnvOptions): EnvCheckReport {
  const source = options?.env ?? (process.env as Record<string, string | undefined>);
  const role = options?.role ?? resolveRole({ env: source });
  const issues: EnvIssue[] = [];
  const values: Record<string, unknown> = {};

  for (const [key, decl] of Object.entries(schema)) {
    const raw = source[key];
    if (raw === undefined || raw === '') {
      if (decl.default !== undefined) {
        values[key] = decl.default;
        continue;
      }
      if (requiredForRole(decl, role)) {
        issues.push({
          key,
          reason: 'missing',
          expected: expectation(decl),
          received: undefined,
          fix: decl.fix ?? `add ${key}= to .env`,
        });
      } else {
        values[key] = undefined;
      }
      continue;
    }
    const parsed = parseValue(decl, raw);
    if (parsed.ok) {
      values[key] = parsed.value;
      continue;
    }
    issues.push({
      key,
      reason: 'invalid',
      expected: expectation(decl),
      received: decl.secret === true ? '***' : raw,
      fix: decl.fix ?? `set ${key} to ${expectation(decl)} in .env`,
    });
  }

  return { ok: issues.length === 0, issues, values };
}

/**
 * Validate the process environment against `schema` and return a frozen typed object.
 * Throws `X_ENV_MISSING` listing EVERY offending key at once.
 */
export function defineEnv<const S extends EnvSchema>(schema: S, options?: EnvOptions): Env<S> {
  const report = checkEnv(schema, options);

  if (options?.redact !== false) {
    const secrets = Object.entries(schema)
      .filter(([, decl]) => decl.secret === true)
      .map(([key]) => key);
    if (secrets.length > 0) redactKeys(secrets);
  }

  if (!report.ok) {
    const cause = report.issues
      .map((issue) =>
        issue.reason === 'missing'
          ? `${issue.key} is missing (expected ${issue.expected})`
          : `${issue.key}="${issue.received ?? ''}" is not ${issue.expected}`,
      )
      .join('; ');
    const keys = report.issues.map((issue) => issue.key).join(' ');
    throw new EnvMissingError({
      cause,
      fix: `add ${keys} to .env (copy .env.example), then run: x env check`,
      meta: { issues: report.issues },
    });
  }

  return Object.freeze(report.values) as Env<S>;
}

/**
 * The resolved values with every `secret: true` key replaced. `checkEnv().values` carries the REAL
 * values because `defineEnv()` has to return them — so anything that PRINTS a report (`x env check
 * --json`, a doctor line, a log field) renders this instead, and the masking lives in one place
 * rather than at each printer.
 */
export function maskedEnvValues(
  schema: EnvSchema,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = schema[key]?.secret === true && value !== undefined ? REDACTED : value;
  }
  return Object.freeze(out);
}

export interface EnvVarSummary {
  readonly key: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  readonly secret: boolean;
  readonly hasDefault: boolean;
  readonly roles: readonly Role[] | 'all';
  readonly description: string | undefined;
}

function rolesOf(role: Role | readonly Role[]): readonly Role[] {
  return typeof role === 'string' ? [role] : role;
}

/** Declarations only, never values — safe to print, safe to commit to `x.manifest.json`. */
export function describeEnv(schema: EnvSchema): readonly EnvVarSummary[] {
  return Object.entries(schema).map(([key, decl]) => ({
    key,
    type: decl.type,
    required: decl.required !== false,
    secret: decl.secret === true,
    hasDefault: decl.default !== undefined,
    roles: decl.role === undefined ? 'all' : rolesOf(decl.role),
    description: decl.description,
  }));
}
