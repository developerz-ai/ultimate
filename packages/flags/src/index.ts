// Public API of @ultimat3/flags. Explicit re-exports only.

export { BUCKETS } from './bucket';
export type { FlagsErrorCode } from './errors';
export { FlagsError, flagExpiryInvalid } from './errors';
export { isEnabled } from './evaluate';
export type { Flag, FlagDef, FlagKind, PermanentFlagDef, TemporaryFlagDef } from './flag';
export type { FlagFacts, FlagsReport } from './projection';
export { flagsReport } from './projection';
export type { SnapshotResult } from './registry';
export { applyFlagSnapshot, defineFlag } from './registry';
export type { FlagsRuntimeOptions } from './runtime';
// The reporter seam is `@ultimat3/core`'s `ErrorReporter`, wired once with
// `runtime.ts`'s `errorReporter`. This package deliberately re-exports none of it.
export { configureFlags } from './runtime';
export type { FlagSubjects } from './subject';
export type { FlagTargeting } from './targeting';
