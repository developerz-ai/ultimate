// Single responsibility: typed environment validation at boot. Every missing or malformed key
// is reported in ONE error — an agent should never have to restart the process six times to
// discover six missing variables.

import { numeric } from '@ultimat3/schema';
import { type Environment, tryResolveEnvironment } from './environment';
import { describeValue, renderFixShellArg } from './error-render';
import { EnvMissingError } from './errors';
import { isRedactedKey, REDACTED, redactKeys } from './logger';
import { type Role, resolveRole } from './roles';
import { redactUrlPassword } from './url-userinfo';

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
  /**
   * With `required: false`: optional, EXCEPT in these environments (`ULTIMATE_ENV`, else
   * `NODE_ENV`) — `requiredIn: ['staging', 'production']` is a key every deploy must set and a
   * laptop or a test run may leave unset. An environment no reader can name counts as listed.
   * Without `required: false` the key is required everywhere already, and this changes nothing.
   */
  readonly requiredIn?: readonly Environment[] | undefined;
  readonly type: 'string' | 'url';
  readonly default?: string | undefined;
  readonly pattern?: RegExp | undefined;
}

export interface EnvNumberVar extends EnvVarCommon {
  /**
   * With `required: false`: optional, EXCEPT in these environments (`ULTIMATE_ENV`, else
   * `NODE_ENV`) — `requiredIn: ['staging', 'production']` is a key every deploy must set and a
   * laptop or a test run may leave unset. An environment no reader can name counts as listed.
   * Without `required: false` the key is required everywhere already, and this changes nothing.
   */
  readonly requiredIn?: readonly Environment[] | undefined;
  readonly type: 'number' | 'integer' | 'port';
  readonly default?: number | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

export interface EnvBooleanVar extends EnvVarCommon {
  /**
   * With `required: false`: optional, EXCEPT in these environments (`ULTIMATE_ENV`, else
   * `NODE_ENV`) — `requiredIn: ['staging', 'production']` is a key every deploy must set and a
   * laptop or a test run may leave unset. An environment no reader can name counts as listed.
   * Without `required: false` the key is required everywhere already, and this changes nothing.
   */
  readonly requiredIn?: readonly Environment[] | undefined;
  readonly type: 'boolean';
  readonly default?: boolean | undefined;
}

export interface EnvEnumVar<V extends string = string> extends EnvVarCommon {
  /**
   * With `required: false`: optional, EXCEPT in these environments (`ULTIMATE_ENV`, else
   * `NODE_ENV`) — `requiredIn: ['staging', 'production']` is a key every deploy must set and a
   * laptop or a test run may leave unset. An environment no reader can name counts as listed.
   * Without `required: false` the key is required everywhere already, and this changes nothing.
   */
  readonly requiredIn?: readonly Environment[] | undefined;
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

/**
 * `required: false` with `requiredIn`: required in a listed environment, and in one no reader can
 * name (`undefined`) — a deploy whose name is a typo fails closed.
 */
function requiredInEnvironment(decl: EnvVarDecl, environment: Environment | undefined): boolean {
  if (decl.requiredIn === undefined) return false;
  return environment === undefined || decl.requiredIn.includes(environment);
}

function requiredForRole(decl: EnvVarDecl, role: Role, environment?: Environment): boolean {
  if (decl.required === false) return requiredInEnvironment(decl, environment);
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
      // Schema's one decimal reader: `Number()` reads `' '` as 0 and `0x1F90` as 8080.
      const value = numeric(raw);
      if (value === undefined) return { ok: false };
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
      if (decl.pattern === undefined) return { ok: true, value: raw };
      // A `g`/`y` pattern resumes at its `lastIndex`: a second check would refuse a valid value.
      decl.pattern.lastIndex = 0;
      if (!decl.pattern.test(raw)) return { ok: false };
      return { ok: true, value: raw };
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The dotenv file a missing key is added to, for the environment `source` names. In development
 * and test it is the per-box file Bun loads last and the scaffold's setup writes
 * (`.env.<environment>.local`) — never `.env`, which no scaffold file is. A deploy
 * (`staging`/`production`, or an `ULTIMATE_ENV` that is no environment: fail closed) reads
 * `.env.production`, the file `x env init --production` writes and `x deploy --method compose` reads.
 */
function envFileFor(source: EnvSource): string {
  const environment = tryResolveEnvironment({ env: source });
  return environment === 'development' || environment === 'test'
    ? `.env.${environment}.local`
    : '.env.production';
}

const keyArg = (key: string): string => renderFixShellArg(key, '<KEY>');

/** `grep` over every dotenv file: a malformed value is in whichever one set it. */
const findLines = (keys: readonly string[]): string =>
  `grep -n ${keys.map((key) => `-e '^${keyArg(key)}='`).join(' ')} .env*`;

/**
 * ONE fix for the whole throw, and never `x env check`: that command prints this same error and
 * this same line. Every missing key gets the line to add, in the file this environment loads; a
 * malformed one is found where it is set. A key whose declaration carries its own `fix` keeps it:
 * the command leads (generated, else the first declared), and every other declared fix follows,
 * named by its key, so one refusal still says how to repair every key.
 */
function fixFor(schema: EnvSchema, issues: readonly EnvIssue[], source: EnvSource): string {
  const declared = issues.flatMap((issue) => {
    const fix = schema[issue.key]?.fix;
    return fix === undefined ? [] : [{ key: issue.key, fix }];
  });
  const lead = generatedFix(schema, issues, source) ?? declared.shift()?.fix;
  const head = lead ?? findLines(issues.map((issue) => issue.key));
  if (declared.length === 0) return head;
  const rest = declared.map(({ key, fix }) => `${key}: ${fix}`).join('; ');
  return `${head}${head.includes('#') ? '; then' : '   # then'}, per key — ${rest}`;
}

/** The command for the keys with no declared fix, or `undefined` when every key declares one. */
function generatedFix(
  schema: EnvSchema,
  issues: readonly EnvIssue[],
  source: EnvSource,
): string | undefined {
  const generated = issues.filter((issue) => schema[issue.key]?.fix === undefined);
  const missing = generated.filter((issue) => issue.reason === 'missing');
  const invalid = generated.filter((issue) => issue.reason === 'invalid');
  const malformed = invalid.map((issue) => `${issue.key} (${issue.expected})`).join(', ');
  if (missing.length === 0) {
    if (invalid.length === 0) return undefined;
    return `${findLines(invalid.map((issue) => issue.key))}   # each line to correct: ${malformed}`;
  }
  const lines = missing.map((issue) => `'${keyArg(issue.key)}=<value>'`);
  const write = lines.length === 1 ? `echo ${lines[0]}` : `printf '%s\\n' ${lines.join(' ')}`;
  const expected = missing.map((issue) => `${issue.key}: ${issue.expected}`).join('; ');
  const also =
    invalid.length === 0
      ? ''
      : `; also malformed, where ${findLines(invalid.map((issue) => issue.key))} finds them: ${malformed}`;
  return `${write} >> ${envFileFor(source)}   # ${expected}${also}`;
}

/** Validate without throwing — this is what `x env check --json` prints. */
export function checkEnv(schema: EnvSchema, options?: EnvOptions): EnvCheckReport {
  const source = options?.env ?? (process.env as Record<string, string | undefined>);
  const role = options?.role ?? resolveRole({ env: source });
  const environment = tryResolveEnvironment({ env: source });
  const issues: EnvIssue[] = [];
  const values: Record<string, unknown> = {};

  for (const [key, decl] of Object.entries(schema)) {
    const raw = source[key];
    if (raw === undefined || raw === '') {
      if (decl.default !== undefined) {
        values[key] = decl.default;
        continue;
      }
      if (requiredForRole(decl, role, environment)) {
        issues.push({
          key,
          reason: 'missing',
          expected: expectation(decl),
          received: undefined,
          fix:
            decl.fix ??
            `echo '${keyArg(key)}=<value>' >> ${envFileFor(source)}   # <value>: ${expectation(decl)}`,
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
      fix: decl.fix ?? `${findLines([key])}   # the line to set to ${expectation(decl)}`,
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
    // The SHAPE of a rejected value, never its content. `secret: true` masks by declaration
    // (`:193`), but the leak is the variable nobody declared secret: the scaffold's own
    // `DATABASE_URL` is not marked, so a malformed `postgres://user:pw@host/db` wrote its
    // password into this `cause` — which is the boot log line AND the `--json` field, where no
    // key is left to redact it by. The value itself still has a printer: `x env check`, through
    // `maskedEnvValues`. `checkEnv().values` and `EnvCheckReport.issues` are untouched.
    const described = report.issues.map((issue) => ({
      ...issue,
      received: issue.received === undefined ? undefined : describeValue(issue.received),
    }));
    const cause = described
      .map((issue) =>
        issue.reason === 'missing'
          ? `${issue.key} is missing (expected ${issue.expected})`
          : `${issue.key} is not ${issue.expected} (received ${issue.received ?? 'undefined'})`,
      )
      .join('; ');
    throw new EnvMissingError({
      cause,
      fix: fixFor(
        schema,
        report.issues,
        options?.env ?? (process.env as Record<string, string | undefined>),
      ),
      meta: { issues: described },
    });
  }

  return Object.freeze(report.values) as Env<S>;
}

/**
 * The resolved values with every `secret: true` key AND every credential-named key (`isRedactedKey`,
 * the logger's and `x config`'s rule) replaced, and any other string's URL password cut from its
 * userinfo. `checkEnv().values` carries the REAL values because `defineEnv()` has to return them —
 * so anything that PRINTS a report (`x env check --json`, a doctor line, a log field) renders this
 * instead, and the masking lives in one place rather than at each printer.
 */
export function maskedEnvValues(
  schema: EnvSchema,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) out[key] = value;
    else if (schema[key]?.secret === true || isRedactedKey(key)) out[key] = REDACTED;
    else out[key] = typeof value === 'string' ? redactUrlPassword(value) : value;
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
  /** `requiredIn`, when an optional key names the environments that require it. */
  readonly requiredIn?: readonly Environment[];
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
    ...(decl.requiredIn === undefined ? {} : { requiredIn: decl.requiredIn }),
    description: decl.description,
  }));
}
