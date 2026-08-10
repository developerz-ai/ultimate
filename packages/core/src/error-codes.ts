// Single responsibility: the framework-wide error-code registry (code -> title + docs).
// One source of truth so the CLI, the dev overlay and `--json` render identical text.
// The cycle with ./errors is intentional and safe: nothing here touches UltimateError at
// module-evaluation time.

import { UltimateError } from './errors';

export interface ErrorCodeDescriptor {
  readonly title: string;
  readonly docs: string;
}

export interface ErrorCodeDeclaration {
  readonly title: string;
  readonly docs?: string | undefined;
}

export interface ErrorCodeEntry extends ErrorCodeDescriptor {
  readonly code: string;
}

export const ERROR_DOCS_BASE = 'https://ultimate.dev/errors/';

export function errorDocsUrl(code: string): string {
  return `${ERROR_DOCS_BASE}${code}`;
}

/** Codes owned by `@ultimat3/core`. Every other package calls `registerErrorCodes()`. */
const CORE_CODE_TITLES = {
  X_ABORTED: 'operation aborted',
  X_CONFIG_INVALID: 'app.config.ts is invalid',
  X_CURSOR_INVALID: 'pagination cursor is malformed, tampered with or from another query',
  X_DRAINING: 'process is draining and refuses new work',
  X_ENV_MISSING: 'required environment variables are missing or invalid',
  X_ERROR_CODE_DUPLICATE: 'error code registered twice',
  X_ID_INVALID: 'value is not a valid id',
  X_IMAGE_DECODE_FAILED: 'image bytes are malformed, truncated or internally inconsistent',
  X_IMAGE_TOO_LARGE: 'image exceeds the pipeline pixel ceiling',
  X_IMAGE_UNSUPPORTED: 'the built-in image pipeline cannot read or write this format',
  X_INTERNAL: 'unexpected internal framework error',
  X_INVARIANT: 'invariant violated',
  X_NO_CONTEXT: 'no request context is active',
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
  X_ROLE_INVALID: 'ROLE is not a known runtime role',
  X_SERVICE_DUPLICATE: 'a service name is registered twice',
  X_SERVICE_MISSING: 'service is not registered on the request context',
  X_SHUTDOWN_TIMEOUT: 'graceful shutdown exceeded its deadline',
  X_UNREACHABLE: 'unreachable branch was reached',
} as const;

export type CoreErrorCode = keyof typeof CORE_CODE_TITLES;

function descriptor(code: string, declaration: ErrorCodeDeclaration): ErrorCodeDescriptor {
  return Object.freeze({ title: declaration.title, docs: declaration.docs ?? errorDocsUrl(code) });
}

export const CORE_ERROR_CODES: Readonly<Record<CoreErrorCode, ErrorCodeDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CORE_CODE_TITLES).map(([code, title]) => [code, descriptor(code, { title })]),
  ) as Record<CoreErrorCode, ErrorCodeDescriptor>,
);

const registry = new Map<string, ErrorCodeDescriptor>(Object.entries(CORE_ERROR_CODES));

/**
 * Register a package's codes. Throws `X_ERROR_CODE_DUPLICATE` on collision so two packages
 * can never disagree about what a code means.
 */
export function registerErrorCodes(codes: Readonly<Record<string, ErrorCodeDeclaration>>): void {
  const duplicates: string[] = [];
  for (const code of Object.keys(codes)) {
    if (registry.has(code)) duplicates.push(code);
  }
  if (duplicates.length > 0) {
    throw new UltimateError({
      code: 'X_ERROR_CODE_DUPLICATE',
      cause: `already registered: ${duplicates.join(', ')}`,
      fix: `rename the colliding code(s) in the registering package's src/errors.ts`,
      meta: { duplicates },
    });
  }
  for (const [code, declaration] of Object.entries(codes)) {
    registry.set(code, descriptor(code, declaration));
  }
}

/** `X_DB_DRIFT` -> `db drift`. Deterministic fallback so an unknown code still renders. */
function humanize(code: string): string {
  return code.replace(/^X_/, '').toLowerCase().replaceAll('_', ' ');
}

export function describeErrorCode(code: string): ErrorCodeDescriptor {
  const known = registry.get(code);
  if (known !== undefined) return known;
  return descriptor(code, { title: humanize(code) });
}

export function hasErrorCode(code: string): boolean {
  return registry.has(code);
}

/** Sorted, stable — the CLI prints this for `x errors --json`. */
export function listErrorCodes(): readonly ErrorCodeEntry[] {
  return [...registry.entries()]
    .map(([code, value]) => ({ code, title: value.title, docs: value.docs }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Test-only: drop everything a package registered, keeping core's codes. */
export function resetErrorCodes(): void {
  registry.clear();
  for (const [code, value] of Object.entries(CORE_ERROR_CODES)) registry.set(code, value);
}

/**
 * Test-only: capture the registry and get the undo back. Every package registers its codes once,
 * at import time, and bun shares one process across test files — so a file that resets the
 * registry permanently strips the titles of every package imported before it, and their errors
 * render the humanised fallback (`X_DB_DRIFT: db drift`) for the rest of the run. Returning the
 * restore rather than a value is deliberate: there is nothing to hand back to the wrong registry.
 */
export function errorCodeSnapshot(): () => void {
  const saved = new Map(registry);
  return () => {
    registry.clear();
    for (const [code, value] of saved) registry.set(code, value);
  };
}
