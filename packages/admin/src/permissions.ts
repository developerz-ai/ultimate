// The admin's own permission set, and the two rules that hang off it: destructive
// operations always re-confirm, and destructive operations are always audited. Both are
// data here (not a code path in a view) so the UI, the HTTP call, and the MCP tool read the
// same table instead of each remembering the rule.

export const ADMIN_READ = 'admin:read';
export const ADMIN_WRITE = 'admin:write';
export const ADMIN_DESTROY = 'admin:destroy';
export const ADMIN_IMPERSONATE = 'admin:impersonate';

export const ADMIN_PERMISSIONS = [
  ADMIN_READ,
  ADMIN_WRITE,
  ADMIN_DESTROY,
  ADMIN_IMPERSONATE,
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Every mutation or read the admin can perform on a resource. */
export type AdminOperation = 'list' | 'detail' | 'search' | 'create' | 'update' | 'delete';

export const ADMIN_OPERATIONS = ['list', 'detail', 'search', 'create', 'update', 'delete'] as const;

export interface AdminPermissionRule {
  /** The admin-level gate. An actor also needs the per-entity permission. */
  readonly permission: AdminPermission;
  /** Destructive: the client must echo a confirmation token before the call runs. */
  readonly destructive: boolean;
  /** Never false. Present so the field exists in `--json` output and in tests. */
  readonly audited: true;
  readonly labelKey: string;
}

const rule = (
  permission: AdminPermission,
  destructive: boolean,
  op: AdminOperation,
): AdminPermissionRule => ({
  permission,
  destructive,
  audited: true,
  labelKey: `admin.operation.${op}`,
});

export const ADMIN_OPERATION_RULES: Readonly<Record<AdminOperation, AdminPermissionRule>> = {
  list: rule(ADMIN_READ, false, 'list'),
  detail: rule(ADMIN_READ, false, 'detail'),
  search: rule(ADMIN_READ, false, 'search'),
  create: rule(ADMIN_WRITE, false, 'create'),
  update: rule(ADMIN_WRITE, false, 'update'),
  delete: rule(ADMIN_DESTROY, true, 'delete'),
};

export function ruleFor(op: AdminOperation): AdminPermissionRule {
  return ADMIN_OPERATION_RULES[op];
}

/** The admin-level permission an operation needs, before the per-entity one. */
export function adminPermissionFor(op: AdminOperation): AdminPermission {
  return ADMIN_OPERATION_RULES[op].permission;
}

/** The per-entity permission, so `post:delete` and `admin:destroy` must BOTH hold. */
export function entityPermissionFor(entity: string, op: AdminOperation): string {
  const verb = op === 'delete' ? 'delete' : op === 'create' || op === 'update' ? 'write' : 'read';
  return `${entity}:${verb}`;
}

export function isDestructive(op: AdminOperation): boolean {
  return ADMIN_OPERATION_RULES[op].destructive;
}

/**
 * The token a destructive call must echo. Deliberately the human-readable record id: a
 * typed-out id is a re-read of what is about to be deleted, and an agent cannot guess it.
 */
export function confirmationToken(entity: string, id: string): string {
  return `${entity}:${id}`;
}

export const CONFIRMATION_REQUIRED_REASON = 'admin.error.confirmation-required';

/** The spec `definePermissions()` is fed with. Kept pure so tests need no policy runtime. */
export const ADMIN_PERMISSION_SPEC: Readonly<
  Record<AdminPermission, { readonly descriptionKey: string; readonly implies: readonly string[] }>
> = {
  [ADMIN_READ]: { descriptionKey: 'admin.permission.read', implies: [] },
  [ADMIN_WRITE]: { descriptionKey: 'admin.permission.write', implies: [ADMIN_READ] },
  [ADMIN_DESTROY]: { descriptionKey: 'admin.permission.destroy', implies: [ADMIN_WRITE] },
  [ADMIN_IMPERSONATE]: { descriptionKey: 'admin.permission.impersonate', implies: [ADMIN_READ] },
};
