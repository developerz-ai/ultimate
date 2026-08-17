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
