// Single responsibility: the DECLARATIONS of this package's error codes, as data — no class.
//
// A leaf of its own, apart from `errors.ts`, because `@ultimat3/core` registers these at load
// (`schema-error-codes.ts`) and core's error contract is in every browser bundle that holds a typed
// client. Declared beside `SchemaError`, the codes dragged the class in with them: a class with a
// computed member (`[ULTIMATE_ERROR_BRAND]`) is not removable by a bundler, so every island paid
// for a server-side validation error it can never construct. Importing only this file keeps
// `errors.ts` out of that graph.

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
    X_SCHEMA_DEFAULT_INVALID: { title: 'a schema default fails its own schema' },
  });
