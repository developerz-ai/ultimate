// Single responsibility: the optional peer's NAME. A leaf, so the modules that build specifiers
// from it (`pglite.ts`, `pglite-extensions.ts`, `pglite-snapshot.ts`) share one spelling without
// importing each other.

/**
 * The optional peer's specifier. Exported because `x doctor` asks whether it RESOLVES — a resolve,
 * never an import, since loading it boots the WASM build and takes the single-writer lock — and a
 * diagnostic that spelled the package name a second time is a diagnostic that can name the wrong
 * one after a rename.
 */
export const PGLITE_PACKAGE = '@electric-sql/pglite';
