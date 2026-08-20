// The public surface of @ultimat3/policy. Explicit, never `export *`.
export type { DecisionSink, MemoryDecisionSink, PolicyDecisionEvent } from './decisions';
export {
  decisionSinkInstalled,
  memoryDecisionSink,
  noopDecisionSink,
  resetDecisionSink,
  setDecisionSink,
} from './decisions';
export type { DefinePolicyInput } from './define';
export { definePolicy } from './define';
export type { PolicyErrorCode } from './errors';
export {
  forbidden,
  POLICY_ERROR_CODES,
  POLICY_ERROR_TITLES,
  PolicyError,
  permissionUnknown,
  policyMissing,
  roleRedefined,
} from './errors';
export type { EvaluateArgs, EvaluateOptions, PolicyEvaluation } from './evaluate';
export {
  codeOf,
  evaluate,
  explain,
  reasonOf,
  renderTrace,
  resetPolicyTracing,
} from './evaluate';
export { actorHas, actorPermissions } from './grant-index';
export type {
  KnownPermission,
  Permission,
  PermissionRegistry,
  PermissionSet,
} from './permissions';
export {
  assertPermission,
  clearPermissions,
  definePermissions,
  isKnownPermission,
  knownPermissions,
  resourceOf,
  restorePermissions,
  verbOf,
} from './permissions';
export type {
  Policy,
  PolicyArgs,
  PolicyDecision,
  PolicyKind,
  PolicyPredicate,
  Recorder,
  TraceEntry,
} from './policy';
export {
  ALLOWED,
  allow,
  and,
  can,
  denied,
  deny,
  not,
  or,
  policyPermissions,
} from './policy';
export type { Actor, RoleDef, RoleMap } from './roles';
export {
  clearRoles,
  defineRoles,
  expandRoles,
  grantMatches,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
  roleMapGeneration,
  rolesGranting,
} from './roles';
export type {
  HttpDenial,
  JobDenial,
  LiveDenial,
  McpDenial,
  Surface,
  SurfaceDenial,
} from './surfaces';
export {
  assertAllowed,
  enforce,
  enforceHttp,
  enforceJob,
  enforceLive,
  enforceMcp,
} from './surfaces';
export type { MatrixArgs, MatrixRow, NamedActor, PolicyMatrix } from './test-kit';
export { policyMatrix, testActor } from './test-kit';
