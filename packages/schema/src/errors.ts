// Single responsibility: this package's error codes. `@ultimat3/schema` is tier 0 and may not
// import `@ultimat3/core`, so `SchemaError` reproduces the `UltimateError` shape structurally
// and carries the same `Symbol.for('ultimate.error')` brand — `isUltimateError()` still matches.

import { formatIssues } from './standard';

/**
 * The same escape `@ultimat3/core`'s `singleLine` performs. **Keep in sync**, and read the reason
 * there — briefly: the 3-line format is line-oriented, and a `cause` may hold a value the caller
 * chose, so a newline in one writes a line an operator reads as a genuine framework message.
 *
 * Copied rather than imported for the same reason the brand symbol above is: `schema` and `core`
 * are both tier 0, so `schema` may not import `core` (imports go DOWN, never sideways). A schema
 * cause is the one most likely to carry a hostile string — it describes the value that failed
 * validation, which is the request body.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
const ESCAPES: Readonly<Record<string, string>> = {
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
};
// `ESCAPES[char]` is a computed read on a plain object and is safe by DOMAIN, not by luck: the
// key is whatever `CONTROL` matched, so it is exactly one control character — and no
// `Object.prototype` member has a single-character name. Every other computed read in this file
// goes through `Object.hasOwn`.
const singleLine = (text: string): string =>
  text.replace(
    CONTROL,
    (char) => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** Same well-known symbol `@ultimat3/core` brands with. Keep in sync, never rename. */
export const ULTIMATE_ERROR_BRAND: unique symbol = Symbol.for('ultimate.error');

/**
 * The same one URL `@ultimat3/core`'s `ERROR_DOCS_URL` holds. **Keep in sync**, and read the
 * reason there — briefly: `wiki/` is the only public documentation surface, codes live on that
 * page in table ROWS, and a table row has no anchor, so there is no per-code URL to build.
 *
 * Spelled out rather than imported for the same reason `singleLine` and the brand symbol above
 * are: `schema` and `core` are both tier 0, so `schema` may not import `core` (imports go DOWN,
 * never sideways). Neither tier-0 package can check the copy against its source, so the pin
 * belongs in `@ultimat3/cli` beside `single-line-pin.test.ts` — it is NOT written yet.
 */
const ERROR_DOCS_URL = 'https://github.com/developerz-ai/ultimate/wiki/Error-Codes';

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
    X_SCHEMA_DISCRIMINANT_INVALID: {
      title: 'a discriminated union member can never be dispatched to',
    },
    X_SCHEMA_DEFAULT_UNSHAREABLE: {
      title: 'a schema default cannot be copied per parse',
    },
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
    // Escaped HERE, once, exactly as `UltimateError`'s constructor does — read the reason there.
    // A schema cause is the one most likely to carry a hostile string: it describes the value that
    // failed validation, which is the request body.
    const code = singleLine(init.code);
    // `Object.hasOwn`, never the read alone: `init.code` is a bare string an app or a provider
    // chose, so `TITLES['constructor']` answered with the `Object` FUNCTION and `singleLine` then
    // called `.replace` on it — the error that reports a bad value died reporting it, and the
    // caller got a `TypeError` in place of its own failure. Same discriminator as
    // `@ultimat3/action`'s `IRREGULAR[word]`.
    const declared = Object.hasOwn(TITLES, init.code) ? TITLES[init.code] : undefined;
    const title = singleLine(declared ?? humanize(init.code));
    const cause = singleLine(init.cause);
    // The cause is in `message` for the reason `UltimateError`'s constructor gives: `message` is
    // the ONLY field a runtime prints when an error escapes uncaught — a worker log, a CI
    // transcript, a stack trace — and `code: title` alone names which rule fired but not which
    // field, row or value. `format()` still renders the canonical 3 lines from the fields, so the
    // two cannot disagree. Kept identical to core's on purpose; both are tier 0 and neither may
    // import the other.
    super(`${code}: ${title} — ${cause}`, { cause });
    this.code = code;
    this.title = title;
    this.fix = singleLine(init.fix);
    this.docs = singleLine(init.docs ?? ERROR_DOCS_URL);
    this.meta = init.meta;
  }

  /** The same 3-line rendering as `UltimateError.format()`, escaped in the same place: neither. */
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

/**
 * Thrown where the union is BUILT, not where a value is parsed: a member no tag can route to is
 * wrong for every input, so the first import of the authoring file is the earliest honest place
 * to say so — never a request that quietly took the wrong branch.
 */
export class DiscriminantInvalidError extends SchemaError {
  static readonly code = 'X_SCHEMA_DISCRIMINANT_INVALID';
  override readonly name = 'DiscriminantInvalidError';

  constructor(init: Omit<SchemaErrorInit, 'code'>) {
    super({ ...init, code: DiscriminantInvalidError.code });
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
