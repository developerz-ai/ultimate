// The error-contract slice of `@ultimat3/core`'s public surface: `UltimateError` and its shipped
// subclasses, the code registry every package registers into, the safe renderers a message is
// built with, and the retry classification a code carries. One group because a code, its title,
// its rendering and its retry class are one contract; `index.ts` re-exports every name explicitly.

export type {
  CoreErrorCode,
  ErrorCodeDeclaration,
  ErrorCodeDescriptor,
  ErrorCodeEntry,
} from '../error-codes';
export {
  CORE_ERROR_CODES,
  describeErrorCode,
  ERROR_DOCS_URL,
  errorCodeSnapshot,
  hasErrorCode,
  listErrorCodes,
  registerErrorCodes,
  resetErrorCodes,
} from '../error-codes';
export {
  describeValue,
  isThrownError,
  MAX_RENDERED_LENGTH,
  renderCauseValue,
  renderFixLiteral,
  renderThrowable,
  singleLine,
  stringField,
} from '../error-render';
export type { ErrorRetry } from '../error-retry';
export {
  classifyThrown,
  DEFAULT_ERROR_RETRY,
  declaredErrorRetry,
  ERROR_RETRY_KINDS,
  isErrorRetry,
  registerErrorRetry,
  registeredErrorRetry,
  resetErrorRetry,
  retryFor,
  statedDelayMs,
} from '../error-retry';
export type {
  CodedErrorInit,
  FormatErrorOptions,
  UltimateErrorInit,
  UltimateErrorJSON,
} from '../errors';
export {
  ConfigInvalidError,
  EnvMissingError,
  errorRetry,
  formatError,
  InternalError,
  isUltimateError,
  NotImplementedError,
  notImplemented,
  toUltimateError,
  ULTIMATE_ERROR_BRAND,
  UltimateError,
} from '../errors';
export { SCHEMA_ERROR_CODE_TITLES } from '../schema-error-codes';
