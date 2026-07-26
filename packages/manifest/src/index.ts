// Public API of @ultimat3/manifest. Explicit — `x verify`, `x manifest`, and the MCP
// `manifest.read` resource are all built from exactly these exports.

export type { AgentsMdCheck, CheckAgentsMdInput } from './agents-md.ts';
export {
  AGENTS_MD_FILENAME,
  AGENTS_MD_MAX_BYTES,
  assertAgentsMd,
  checkAgentsMd,
} from './agents-md.ts';
export type { ManifestSources } from './build.ts';
export { buildManifest, canonical, contentHash } from './build.ts';
export type { ChangeKind, ManifestChange, ManifestDiff } from './diff.ts';
export { diffManifest, formatDiff } from './diff.ts';
export type { EmitInput, EmitResult } from './emit.ts';
export {
  assertNoDrift,
  emitManifest,
  MANIFEST_FILENAME,
  manifestJson,
  readManifest,
  verifyBuildId,
} from './emit.ts';
export type { ManifestErrorCode } from './errors.ts';
export {
  AgentsMdMissingError,
  AgentsMdTooLargeError,
  MANIFEST_ERROR_CODES,
  ManifestBreakingError,
  ManifestDriftError,
} from './errors.ts';
export type {
  ActionFact,
  ColumnFact,
  EntityFact,
  ErrorCodeFact,
  HydrateStrategy,
  JobFact,
  JsonValue,
  Manifest,
  OfflineStrategy,
  PolicyFact,
  QueryFact,
  RenderMode,
  RouteFact,
  TaskFact,
} from './schema.ts';
export { isCompatible, isManifest, MANIFEST_VERSION } from './schema.ts';
export type { FrameworkSourcesInput } from './sources.ts';
export { frameworkSources } from './sources.ts';
export type { VerifyContractInput, VerifyContractResult } from './verify.ts';
export { verifyContract } from './verify.ts';
