// Single responsibility: the public API of @ultimat3/schema. Explicit named exports only.

export type {
  AnySchema,
  Check,
  CheckErr,
  CheckOk,
  CheckResult,
  Path,
  Refinement,
  Schema,
  Shape,
  ShapeInput,
  ShapeOutput,
  Simplify,
} from './builder';
export { checkOf, fail, failWith, makeSchema, pass, VENDOR } from './builder';
// Exported since 2026-08-24 for `@ultimat3/mcp`'s `validate-args.ts`, which enforces the very
// `minLength`/`maxLength` this package MINTS: it counted UTF-16 code units against numbers minted
// in code points, so an astral argument was passed silently past a bound it broke and refused
// against a bound it met. `@ultimat3/core`'s private twin stays private — core is tier 0 and may
// not import this package — but `mcp` is tier 4 and can, so a copy there would have no excuse.
export { charCount } from './char-count';
export type { QuerySource } from './coerce';
export { coerceInput, coerceNode, coerceQuery } from './coerce';
export { describeValue, expected } from './describe-value';
export { discriminatedUnionSchema } from './discriminated-union';
export type {
  SchemaErrorCodeDeclaration,
  SchemaErrorInit,
  SchemaErrorJSON,
  ValidationIssue,
} from './errors';
export {
  DiscriminantInvalidError,
  isSchemaError,
  SCHEMA_ERROR_CODES,
  SchemaError,
  SchemaUnsupportedError,
  ULTIMATE_ERROR_BRAND,
  ValidationFailedError,
} from './errors';
export type {
  JsonSchema,
  JsonSchemaDialect,
  JsonSchemaDiscriminator,
  JsonSchemaType,
  ToJsonSchemaOptions,
} from './json-schema';
export { nodeToJsonSchema, toJsonSchema, toMcpInputSchema } from './json-schema';
export type { MoneyValue } from './money-value';
export {
  CURRENCY_CODE_PATTERN,
  isCurrencyCode,
  isMoneyScale,
  MAX_MONEY_SCALE,
} from './money-value';
export type { SchemaFormat, SchemaKind, SchemaNode, SchemaRefinement } from './node';
export { isSchemaNode, nodeOf, requiredKeys } from './node';
export type { SchemaProvider } from './provider';
export {
  builtinProvider,
  configureSchemaProvider,
  introspect,
  resetSchemaProvider,
  schemaProvider,
  tryIntrospect,
} from './provider';
export type {
  FormattableIssue,
  InferInput,
  InferOutput,
  StandardFailureResult,
  StandardIssue,
  StandardPathSegment,
  StandardResult,
  StandardSchemaProps,
  StandardSchemaV1,
  StandardSuccessResult,
  StandardTypes,
} from './standard';
export {
  formatIssues,
  formatPath,
  isStandardSchema,
  parse,
  parseAsync,
  toValidationIssues,
  validate,
  validateAsync,
} from './standard';
export type { Infer } from './t';
export { t } from './t';
export { isIanaZoneName } from './time-zone-name';
export type {
  NumberSchema,
  ObjectSchema,
  StringSchema,
  TNamespace,
} from './validators';
export {
  arraySchema,
  builtinT,
  enumSchema,
  literalSchema,
  nullableSchema,
  objectSchema,
  optionalSchema,
  recordSchema,
  refineSchema,
  unionSchema,
} from './validators';
