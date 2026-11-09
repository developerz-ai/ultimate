// The public surface of @ultimat3/policy. Explicit, never `export *`.
// The `policy.decision` payload is core's (the bus is tier 0); re-exported, never a second shape.
export type { PolicyDecisionEvent } from '@ultimat3/core';
export type { DefinePolicyInput } from './define';
export { definePolicy } from './define';
export { denialCode, denialReason } from './denial-parts';
export type { PolicyErrorCode } from './errors';
export {
  denialError,
  emptyClauseList,
  POLICY_BORROWED_ERROR_CODES,
  POLICY_ERROR_CODES,
  POLICY_ERROR_TITLES,
  PolicyDenialError,
  PolicyError,
  permissionUnknown,
  policyForbidden,
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
  ActorStageSubject,
  GuardedPrimitive,
  GuardSubject,
  InputStageSubject,
  PrimitiveDenial,
  PrimitiveSurface,
  PrimitiveSurfaces,
} from './guard-primitive';
export { guardPrimitive, PRIMITIVE_POLICY_SURFACES } from './guard-primitive';
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
  permissionDeclarationSites,
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
  policyCapability,
  policyPermissions,
} from './policy';
export { admitsAnonymous } from './policy-anonymous';
export type { PreInputArgs } from './pre-input';
export { decideBeforeInput, enforceBeforeInput } from './pre-input';
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
  DenialStatus,
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
