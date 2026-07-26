export type { DefinePolicyInput } from './define';
export { definePolicy } from './define';
// The public surface of @ultimat3/policy. Explicit, never `export *`.

export type { PolicyErrorCode } from './errors';
export {
  forbidden,
  POLICY_ERROR_CODES,
  POLICY_ERROR_TITLES,
  PolicyError,
  permissionUnknown,
  policyMissing,
} from './errors';
export type { EvaluateArgs, PolicyEvaluation } from './evaluate';
export { codeOf, evaluate, explain, reasonOf, renderTrace } from './evaluate';
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
export { ALLOWED, allow, and, can, denied, deny, not, or } from './policy';
export type { Actor, PolicyActorFields, RoleDef, RoleMap } from './roles';
export {
  actorHas,
  actorPermissions,
  clearRoles,
  defineRoles,
  expandRoles,
  grantMatches,
  roleDefinitions,
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
