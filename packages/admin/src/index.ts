// The public surface of @ultimat3/admin: the generated app admin, and the /_x dev dashboard.
// Explicit exports only — a barrel that re-exports everything is how internal helpers become
// someone's dependency.

export {
  type ActionGateInput,
  type AdminActionButton,
  actionButtons,
  actionDecisions,
  decideAction,
  type InvokeInput,
  type InvokeResult,
  invokeAdminAction,
  permissionsForAction,
} from './action-gate';
export { AdminActions, type AdminActionsProps } from './actions';
export {
  type AdminApp,
  type AdminAuth,
  type AdminRoute,
  type AdminView,
  type DefineAdminInput,
  defineAdmin,
} from './admin';
export {
  AI_PANES,
  type AiPane,
  type AiPaneFacts,
  type AiPaneRequest,
  type AiPaneResult,
  type AiPaneScope,
  type AiPanesOptions,
  type AiRunner,
  aiPanes,
  type GatewayAdapter,
  runAiPane,
} from './ai-panes';
export {
  type AuditDraft,
  type AuditEntry,
  type AuditFieldDiff,
  type AuditLog,
  type AuditLogOptions,
  type AuditOutcome,
  type AuditSink,
  auditEntry,
  deniedDraft,
  diffRows,
  memoryAuditLog,
  REDACTED,
} from './audit';
export {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  type AdminSubject,
  allowed,
  anonymousAuthz,
  decideAll,
  denied,
  expandPermissions,
  isAllowed,
  staticAuthz,
} from './authz';
export {
  adminCreate,
  adminDestroy,
  adminDetail,
  adminList,
  adminUpdate,
  type CrudCtx,
  type CrudResult,
  canOperate,
  decideOperation,
  type ListResult,
  permissionsForOperation,
} from './crud';
export { AdminDetail, type AdminDetailProps } from './detail';
export {
  type AdminColumnFacts,
  type AdminColumnReference,
  adminColumnsOf,
} from './entity-columns';
// The /_x dashboard is NOT re-exported here — it has its own door, `@ultimat3/admin/dev`, so a
// host that only mounts the dev panels never loads a production admin component.
export {
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_TITLES,
  AdminEntityUnknownError,
  type AdminErrorCode,
  type AdminErrorParts,
  AdminFieldUnsupportedError,
  AdminPolicyMissingError,
  adminErrorFrom,
  DevDashboardInProdError,
  DevSourceUnavailableError,
} from './errors';
export {
  type AdminField,
  type AdminFieldType,
  type AdminWidget,
  fieldTypeFromColumn,
  filterable,
  listable,
  searchable,
  sortable,
  WIDGET_BY_FIELD_TYPE,
  widgetFor,
} from './fields';
export { AdminForm, type AdminFormProps } from './form';
export { AdminLayout, type AdminLayoutProps } from './layout';
export { AdminList, type AdminListProps } from './list';
export {
  type AdminMcpOptions,
  type AdminToolResult,
  adminMcp,
  callAdminTool,
  type McpInput,
} from './mcp';
export {
  type AdminMcpTool,
  type AdminToolField,
  type AdminToolKind,
  adminMcpTools,
  adminToolCatalog,
  adminToolDecisions,
} from './mcp-tools';
export { adminNav, type NavGroup, type NavItem, type NavOptions, visibleNav } from './nav';
export {
  type AdminCursor,
  type AdminPage,
  decodeAdminCursor,
  encodeAdminCursor,
  fetchPage,
  listQuery,
  type PageRequest,
  pageFrom,
} from './pagination';
export {
  ADMIN_DESTROY,
  ADMIN_IMPERSONATE,
  ADMIN_OPERATION_RULES,
  ADMIN_OPERATIONS,
  ADMIN_PERMISSION_SPEC,
  ADMIN_PERMISSIONS,
  ADMIN_READ,
  ADMIN_WRITE,
  type AdminOperation,
  type AdminPermission,
  type AdminPermissionRule,
  adminPermissionFor,
  CONFIRMATION_REQUIRED_REASON,
  confirmationToken,
  entityPermissionFor,
  isDestructive,
  ruleFor,
} from './permissions';
export { adminPermissions, type PolicyAuthzInput, policyAuthz } from './policy-bridge';
export {
  type AdminAction,
  type AdminActionCtx,
  type AdminColumn,
  type AdminColumnDescription,
  type AdminColumnMeta,
  type AdminEntity,
  type AdminEntityDescription,
  type AdminFilter,
  type AdminJobSummary,
  type AdminListQuery,
  type AdminRepo,
  type AdminRow,
  type AdminSort,
  type FilterOp,
  type KeysetBound,
  type RegisteredEntity,
  type RegisteredRepo,
  readField,
  rowId,
} from './registry';
export {
  type AdminFieldOverride,
  type AdminResource,
  type AdminResourceOptions,
  adminResource,
  repoOf,
  resourceFor,
} from './resource';
export { type AdminRouteConfig, adminRouteConfig, adminRoutes } from './routes';
export {
  type AdminSearchHit,
  type AdminSearchInput,
  type AdminSearchResult,
  adminSearch,
} from './search';
export {
  type AdminBranding,
  adminBranding,
  defaultBranding,
  type ThemeAttributes,
  type ThemeMode,
  type ThemeTokenRef,
  themeAttributes,
} from './theme';
export { type ValidationIssue, type ValidationResult, validateInput } from './validate';
export {
  assertMoney,
  assertZone,
  type SelectOption,
  type WidgetContext,
  type WidgetProps,
  widgetProps,
} from './widget-value';
export { Widget, type WidgetInput } from './widgets';
