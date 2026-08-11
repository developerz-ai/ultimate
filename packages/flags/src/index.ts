// Public API of @ultimat3/flags. Explicit re-exports only.

export { BUCKETS, bucketOf, fnv1a } from './bucket';
export type { FlagsErrorCode } from './errors';
export {
  FLAGS_ERROR_CODES,
  FLAGS_ERROR_TITLES,
  FlagsError,
  flagDuplicate,
  flagExpired,
  flagExpiryInvalid,
  flagTargetingInvalid,
  flagUnknown,
} from './errors';
export { isEnabled } from './evaluate';
export type {
  Flag,
  FlagDef,
  FlagExpiryIsMandatory,
  FlagKind,
  PermanentFlagDef,
  TemporaryFlagDef,
} from './flag';
export { FLAG_KINDS } from './flag';
export type { FlagFacts, FlagsReport } from './projection';
export { flagsReport } from './projection';
export type { SnapshotResult } from './registry';
export { allFlags, applyFlagSnapshot, defineFlag, hasFlag, resetFlags } from './registry';
export type { FlagsRuntimeOptions } from './runtime';
// The reporter seam is `@ultimat3/core`'s `ErrorReporter`, wired once with
// `configureErrorReporting()`. This package deliberately re-exports none of it.
export { configureFlags, DEFAULT_REPORT_INTERVAL_MS, resetFlagReporting } from './runtime';
export type { FlagTargeting } from './targeting';
