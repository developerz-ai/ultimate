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

/**
 * Where an error sends its reader. One URL for every code, and deliberately not one per code:
 * `wiki/` is the framework's only public documentation surface, codes live there in TABLE ROWS,
 * and a table row has no anchor — so a `#X_DB_DRIFT` fragment would land on the page top while
 * declaring a target that does not exist. The `https://ultimate.dev/errors/<code>` links this
 * shipped until 9.x answered 404, host included, on every error the framework has ever thrown.
 */
export const ERROR_DOCS_URL = 'https://github.com/developerz-ai/ultimate/wiki/Error-Codes';

export function descriptor(declaration: ErrorCodeDeclaration): ErrorCodeDescriptor {
  return Object.freeze({ title: declaration.title, docs: declaration.docs ?? ERROR_DOCS_URL });
}

/**
 * Empty at load, on purpose: core's own titles live in `core-error-codes.ts`, which the barrel
 * bare-imports as a side-effect anchor. A browser module that constructs an `UltimateError` from a
 * light path pays for the class and this lookup, not a 40-row table — an untitled code renders
 * through `humanize`, the trade `@ultimat3/realtime` already made for its own titles.
 */
const registry = new Map<string, ErrorCodeDescriptor>();

/** What `resetErrorCodes` restores: the codes `registerCoreErrorCodes` installed. */
const coreCodes = new Map<string, ErrorCodeDescriptor>();

/** `core-error-codes.ts`'s one call. Registered like any package's, and remembered for a reset. */
export function registerCoreErrorCodes(codes: Readonly<Record<string, ErrorCodeDescriptor>>): void {
  registerErrorCodes(codes);
  for (const [code, value] of Object.entries(codes)) coreCodes.set(code, value);
}

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
    registry.set(code, descriptor(declaration));
  }
}

/** `X_DB_DRIFT` -> `db drift`. Deterministic fallback so an unknown code still renders. */
function humanize(code: string): string {
  return code.replace(/^X_/, '').toLowerCase().replaceAll('_', ' ');
}

export function describeErrorCode(code: string): ErrorCodeDescriptor {
  const known = registry.get(code);
  if (known !== undefined) return known;
  return descriptor({ title: humanize(code) });
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
  for (const [code, value] of coreCodes) registry.set(code, value);
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
