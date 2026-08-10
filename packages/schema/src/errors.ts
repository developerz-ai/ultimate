// Single responsibility: this package's error codes. `@ultimat3/schema` is tier 0 and may not
// import `@ultimat3/core`, so `SchemaError` reproduces the `UltimateError` shape structurally
// and carries the same `Symbol.for('ultimate.error')` brand — `isUltimateError()` still matches.

import { formatIssues } from './standard';

/** Same well-known symbol `@ultimat3/core` brands with. Keep in sync, never rename. */
export const ULTIMATE_ERROR_BRAND: unique symbol = Symbol.for('ultimate.error');

export interface SchemaErrorCodeDeclaration {
  readonly title: string;
  readonly docs?: string | undefined;
}

/**
 * Pass to `registerErrorCodes()` from a package that may import both tiers (the CLI does this
 * at boot) so the terminal and the dev overlay render these codes identically.
 */
export const SCHEMA_ERROR_CODES: Readonly<Record<string, SchemaErrorCodeDeclaration>> =
  Object.freeze({
    X_VALIDATION_FAILED: { title: 'value did not match its schema' },
    X_SCHEMA_UNSUPPORTED: { title: 'the active schema provider cannot do this' },
  });

/**
 * Derived, never re-typed: the declarations above are the single source, so a title edited there
 * cannot fall out of step with what `SchemaError` renders locally.
 */
const TITLES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SCHEMA_ERROR_CODES).map(([code, declaration]) => [code, declaration.title]),
  ),
);

/** `X_SCHEMA_UNSUPPORTED` -> `schema unsupported`, same fallback as the core registry. */
function humanize(code: string): string {
  return code.replace(/^X_/, '').toLowerCase().replaceAll('_', ' ');
}

export interface SchemaErrorInit {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export interface SchemaErrorJSON {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export class SchemaError extends Error {
  readonly [ULTIMATE_ERROR_BRAND] = true;
  override readonly name: string = 'SchemaError';
  readonly code: string;
  readonly title: string;
  declare readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly meta: Readonly<Record<string, unknown>> | undefined;

  constructor(init: SchemaErrorInit) {
    const title = TITLES[init.code] ?? humanize(init.code);
    super(`${init.code}: ${title}`, { cause: init.cause });
    this.code = init.code;
    this.title = title;
    this.fix = init.fix;
    this.docs = init.docs ?? `https://ultimate.dev/errors/${init.code}`;
    this.meta = init.meta;
  }

  /** The same 3-line rendering as `UltimateError.format()`. */
  format(): string {
    return [`${this.code}: ${this.title}`, `  cause: ${this.cause}`, `  fix:   ${this.fix}`].join(
      '\n',
    );
  }

  toJSON(): SchemaErrorJSON {
    return {
      code: this.code,
      title: this.title,
      cause: this.cause,
      fix: this.fix,
      docs: this.docs,
      meta: this.meta,
    };
  }
}

export interface ValidationIssue {
  /** Dotted path from the validated root, e.g. `input.items[0].price`. */
  readonly path: string;
  readonly expected: string;
  readonly received: string;
  readonly message: string;
}

export class ValidationFailedError extends SchemaError {
  static readonly code = 'X_VALIDATION_FAILED';
  override readonly name = 'ValidationFailedError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], root = 'value') {
    const cause = issues
      .map((issue) => `${issue.path === '' ? root : issue.path}: ${issue.message}`)
      .join('; ');
    super({
      code: ValidationFailedError.code,
      cause,
      fix: `send ${root} with the field(s) named in cause corrected to the expected type`,
      meta: { issues },
    });
    this.issues = issues;
  }

  /** One line per issue — what the dev overlay and `x test --json` render. */
  formatIssues(): string {
    return formatIssues(this.issues)
      .map((line) => `  ${line}`)
      .join('\n');
  }
}

export class SchemaUnsupportedError extends SchemaError {
  static readonly code = 'X_SCHEMA_UNSUPPORTED';
  override readonly name = 'SchemaUnsupportedError';
  constructor(init: Omit<SchemaErrorInit, 'code'>) {
    super({ ...init, code: SchemaUnsupportedError.code });
  }
}

export function isSchemaError(value: unknown): value is SchemaError {
  return typeof value === 'object' && value !== null && ULTIMATE_ERROR_BRAND in value;
}
