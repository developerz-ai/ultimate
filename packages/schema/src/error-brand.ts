// Single responsibility: the ONE brand every framework error carries — `SchemaError` here,
// `UltimateError` in `@ultimat3/core`, which imports this declaration over the `core -> schema`
// edge. A leaf of its own for `error-codes.ts`'s reason: core's error contract is in every browser
// bundle, and importing the brand from `errors.ts` would drag `SchemaError` and its table in too.

/**
 * Never renamed: the `Symbol.for` key is what a duplicated module instance recognises, so
 * `isUltimateError()` stays true across two copies of a package in one process.
 */
export const ULTIMATE_ERROR_BRAND: unique symbol = Symbol.for('ultimate.error');
