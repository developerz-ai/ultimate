// Public API of @ultimat3/manifest. Explicit — `x verify`, `x manifest`, and the MCP
// `manifest.read` resource are all built from exactly these exports.

export type { AgentsMdCheck, CheckAgentsMdInput } from './agents-md';
export {
  AGENTS_MD_FILENAME,
  AGENTS_MD_MAX_BYTES,
  assertAgentsMd,
  checkAgentsMd,
} from './agents-md';
export type { ManifestSources } from './build';
export { buildManifest, canonical, contentHash } from './build';
export type { ChangeKind, ManifestChange, ManifestDiff } from './diff';
export { diffManifest, formatDiff } from './diff';
export type { EmitInput, EmitResult } from './emit';
export {
  assertNoDrift,
  emitManifest,
  MANIFEST_FILENAME,
  manifestJson,
  readManifest,
  verifyBuildId,
} from './emit';
export type { ManifestErrorCode } from './errors';
export {
  AgentsMdMissingError,
  AgentsMdTooLargeError,
  MANIFEST_ERROR_CODES,
  ManifestBreakingError,
  ManifestDriftError,
} from './errors';
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
} from './schema';
export { isCompatible, isManifest, MANIFEST_VERSION } from './schema';
export type { FrameworkSourcesInput } from './sources';
export { frameworkSources } from './sources';
export type { VerifyContractInput, VerifyContractResult } from './verify';
export { verifyContract } from './verify';
