// Single responsibility: the public API of @ultimat3/schema. Explicit named exports only.

export type {
  AnySchema,
  Check,
  CheckErr,
  CheckOk,
  CheckResult,
  Path,
  Schema,
  Shape,
  ShapeInput,
  ShapeOutput,
  Simplify,
} from './builder';
export {
  checkOf,
  describeValue,
  expected,
  fail,
  failWith,
  makeSchema,
  pass,
  VENDOR,
} from './builder';
export type { QuerySource } from './coerce';
export { coerceInput, coerceNode, coerceQuery } from './coerce';
export type {
  SchemaErrorCodeDeclaration,
  SchemaErrorInit,
  SchemaErrorJSON,
  ValidationIssue,
} from './errors';
export {
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
  JsonSchemaType,
  ToJsonSchemaOptions,
} from './json-schema';
export { nodeToJsonSchema, toJsonSchema, toMcpInputSchema } from './json-schema';
export type { SchemaFormat, SchemaKind, SchemaNode } from './node';
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
  MoneyValue,
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
  unionSchema,
} from './validators';
