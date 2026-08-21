// Public API of @ultimat3/manifest. Explicit — `x verify`, `x manifest`, and the MCP
// `manifest.read` resource are all built from exactly these exports.

export type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
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
export type { DocEntry, DocEntryKind } from './docs-scan';
export {
  headerComment,
  parseGuideSections,
  parseReExports,
  scanInstalledDocs,
  scanPackageDocs,
  shortName,
} from './docs-scan';
export type { DocHit } from './docs-search';
export { nearestTopics, searchDocs, tokenize } from './docs-search';
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
  MANIFEST_ERROR_TITLES,
  ManifestBreakingError,
  ManifestDriftError,
} from './errors';
export type {
  ActionFact,
  ColumnFact,
  EntityFact,
  ErrorCodeFact,
  JobFact,
  JsonValue,
  Manifest,
  PolicyFact,
  QueryFact,
  RateLimitFact,
  RouteFact,
  TaskFact,
} from './schema';
export { isCompatible, isManifest, MANIFEST_VERSION } from './schema';
export type { FrameworkSourcesInput } from './sources';
export { frameworkSources } from './sources';
export type { VerifyContractInput, VerifyContractResult } from './verify';
export { verifyContract } from './verify';
