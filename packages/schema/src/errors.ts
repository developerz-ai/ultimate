// Single responsibility: this package's error codes. `@ultimat3/schema` is tier 0 and may not
// import `@ultimat3/core`, so `SchemaError` reproduces the `UltimateError` shape structurally
// and carries the one brand both classes share (`error-brand.ts`) — `isUltimateError()` matches.

import { ULTIMATE_ERROR_BRAND } from './error-brand';
import { SCHEMA_ERROR_CODES } from './error-codes';
import { renderMetaRecord } from './render-meta';
import { formatIssues } from './standard';

/**
 * The same escape `@ultimat3/core`'s `singleLine` performs. **Keep in sync**, and read the reason
 * there — briefly: the 3-line format is line-oriented, and a `cause` may hold a value the caller
 * chose, so a newline in one writes a line an operator reads as a genuine framework message.
 *
 * Copied rather than imported: `schema` and `core` are both tier 0, and only `core -> schema` is a
 * declared edge, so `schema` may not import `core`. A schema
 * cause is the one most likely to carry a hostile string — it describes the value that failed
 * validation, which is the request body.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;
// Null-prototype, so `ESCAPES[char]` cannot answer an `Object.prototype` member no matter what
// `CONTROL` matched. The domain argument — a key is exactly one control character, and no
// prototype member has a single-character name — was true and is no longer load-bearing; a table
// that cannot reach the prototype needs no argument, and `bun run proto-index` stops reporting it.
const ESCAPES: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
});
const singleLine = (text: string): string =>
  text.replace(
    CONTROL,
    (char) => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

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

/**
 * Derived, never re-typed: the declarations in `error-codes.ts` are the single source, so a title
 * edited there cannot fall out of step with what `SchemaError` renders locally.
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
  /** Always present, as on `UltimateErrorJSON` — a client never has to infer it. */
  readonly retry: 'terminal';
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export interface SchemaFormatOptions {
  /** Append a 4th `docs:` line. Off by default, as `UltimateError.format()` has it. */
  readonly docs?: boolean | undefined;
}

export class SchemaError extends Error {
  readonly [ULTIMATE_ERROR_BRAND] = true;
  override readonly name: string = 'SchemaError';
  readonly code: string;
  readonly title: string;
  declare readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  /**
   * `terminal` on every instance: a value that does not match its schema does not match it on
   * attempt five. Carried HERE as well as in core's retry registry because `errorRetryOf` reads
   * the field off the error, and a process that never imported core has no registry to ask.
   */
  readonly retry = 'terminal' as const;
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
  format(options?: SchemaFormatOptions): string {
    const lines = [`${this.code}: ${this.title}`, `  cause: ${this.cause}`, `  fix:   ${this.fix}`];
    if (options?.docs === true) lines.push(`  docs:  ${this.docs}`);
    return lines.join('\n');
  }

  toJSON(): SchemaErrorJSON {
    return {
      code: this.code,
      title: this.title,
      cause: this.cause,
      fix: this.fix,
      docs: this.docs,
      retry: this.retry,
      // A schema error's `meta` can hold what the caller sent; a `bigint` or a cycle in it threw
      // here, at `--json` render time, one layer past a constructor that had already succeeded.
      meta: renderMetaRecord(this.meta),
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

/** Thrown where `.default()` is WRITTEN: a fallback the schema itself refuses is wrong for every parse. */
export class DefaultInvalidError extends SchemaError {
  static readonly code = 'X_SCHEMA_DEFAULT_INVALID';
  override readonly name = 'DefaultInvalidError';

  constructor(init: Omit<SchemaErrorInit, 'code'>) {
    super({ ...init, code: DefaultInvalidError.code });
  }
}

/**
 * Thrown where `t.array(items, { min, max })` is WRITTEN: a bound no item count meets refuses every
 * input, and the first import of the authoring file is the earliest honest place to say so.
 */
export class BoundsInvalidError extends SchemaError {
  static readonly code = 'X_SCHEMA_BOUNDS_INVALID';
  override readonly name = 'BoundsInvalidError';

  constructor(init: Omit<SchemaErrorInit, 'code'>) {
    super({ ...init, code: BoundsInvalidError.code });
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
