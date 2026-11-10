// The public surface of @ultimat3/admin: the generated app admin, and the /_x dev dashboard.
// Explicit exports only — a barrel that re-exports everything is how internal helpers become
// someone's dependency.

export {
  type ActionGateInput,
  type AdminActionButton,
  actionButtons,
  adminPermissionForAction,
  decideAction,
  type InvokeInput,
  type InvokeResult,
  invokeAdminAction,
  permissionsForAction,
} from './action-gate';
export { invokeRowAction, type RowActionInput } from './action-row';
export { AdminActions, type AdminActionsProps } from './actions';
export { adminActorFrom } from './actor';
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
  runAiPane,
} from './ai-panes';
export {
  type AuditCursor,
  type AuditDraft,
  type AuditEntry,
  type AuditFieldDiff,
  type AuditLog,
  type AuditLogOptions,
  type AuditOutcome,
  type AuditQuery,
  auditCursorOf,
  auditEntryMatches,
  auditWindow,
  deniedDraft,
  diffRows,
  memoryAuditLog,
} from './audit';
export { type PostgresAuditLogOptions, postgresAuditLog } from './audit-pg';
export { type AuditRequest, auditHref, auditRequestOf, HISTORY_PARAM } from './audit-request';
// The audit table's DDL is `@ultimat3/admin/schema`'s alone — one import path for one statement.
export {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  type AdminSubject,
  adminAllowed,
  adminDenied,
  decideAll,
  expandPermissions,
  staticAuthz,
} from './authz';
export {
  type AdminBatchAnswer,
  type AdminBatchInput,
  type AdminBatchResult,
  type BatchEnqueue,
  type BatchRow,
  type BatchRowOutcome,
  type BatchSelection,
  batchPlan,
  MAX_BATCH_QUEUED_ROWS,
  MAX_BATCH_ROWS,
  runAdminBatch,
} from './batch';
export { BATCH_QUEUED_REASON } from './batch-queue';
export {
  type AdminClaimData,
  type AdminClaimLoadArgs,
  type ClaimAdminRouteOptions,
  claimAdminRoute,
} from './claim-route';
export {
  type AdminUpdateOptions,
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
export type {
  AdminActionDescription,
  AdminDescription,
  AdminResourceDescription,
  AdminRouteDescription,
  AdminScopeDescription,
  AdminSectionDescription,
} from './describe';
export { AdminDetail, type AdminDetailProps } from './detail';
export type { AdminColumnFacts, AdminColumnReference } from './entity-columns';
// The screens only. The sink and its stores are `@ultimat3/admin/error-groups`'s alone: every role
// installs the sink, and this barrel would carry every admin screen into a worker's graph.
export { ERRORS_READ, type ErrorGroupsPagesOptions, errorGroupsPages } from './error-groups-pages';
export type { AdminErrorCode } from './errors';
// The /_x dashboard is NOT re-exported here — it has its own door, `@ultimat3/admin/dev`, so a
// host that only mounts the dev panels never loads a production admin component.
export {
  AdminActionDuplicateError,
  AdminActionNotApplicableError,
  AdminEntityUnknownError,
  type AdminErrorParts,
  AdminFieldUnsupportedError,
  AdminFilterInvalidError,
  AdminMountMissingError,
  AdminPagePathInvalidError,
  AdminPageUnguardedError,
  AdminPolicyMissingError,
  AdminRepoUnboundError,
  DevDashboardInProdError,
  DevSourceUnavailableError,
} from './errors';
export {
  type AdminField,
  type AdminFieldType,
  type AdminFilterKind,
  type AdminWidget,
  filterable,
  listable,
  searchable,
  sortable,
} from './fields';
export { AdminForm, type AdminFormProps } from './form';
export { posted } from './form-decode';
export { JOB_MANAGE, JOB_READ } from './jobs/job-actions';
export { jobRowScope } from './jobs/job-resources';
export { AdminLayout, type AdminLayoutProps, adminActorLabel } from './layout';
export { AdminList, type AdminListProps } from './list';
export { type ListLocation, listHref, pageRequestOf } from './list-request';
export { type AdminListRequest, findRow, type ListWhere, listWhere } from './list-scope';
export { type AdminMcpActor, type AdminMcpOptions, adminMcp } from './mcp';
export { type AdminToolResult, callAdminTool, type McpInput } from './mcp-dispatch';
export { adminTokenScopes, adminToolScopes } from './mcp-scopes';
export {
  type AdminMcpTool,
  type AdminToolField,
  type AdminToolKind,
  adminMcpTools,
  adminToolCatalog,
} from './mcp-tools';
export { ADMIN_MOUNTS, adminMounts, clearAdminMounts } from './mounts';
export { type NavGroup, type NavItem, type NavOptions, visibleNav } from './nav';
export { AdminPageDenied } from './page-guard';
export {
  type AdminCustomPage,
  type AdminPageComponent,
  type AdminPageProps,
  pagePermissions,
  pageRoutes,
} from './pages';
export { type AdminCursor, type AdminPage, type PageRequest, pageFrom } from './pagination';
export {
  ADMIN_DESTROY,
  ADMIN_OPERATION_RULES,
  ADMIN_PERMISSION_SPEC,
  ADMIN_PERMISSIONS,
  ADMIN_READ,
  ADMIN_WRITE,
  type AdminOperation,
  type AdminPermission,
  type AdminPermissionRule,
  confirmationToken,
  entityPermissionFor,
  isDestructive,
  ruleFor,
} from './permissions';
export {
  declareAdminPermissions,
  type PolicyAuthzInput,
  policyAuthz,
  roleAuthz,
  singlePolicyAuthz,
} from './policy-bridge';
export {
  type AdminAction,
  type AdminActionCtx,
  type AdminBatchOptions,
  type AdminColumn,
  type AdminColumnDescription,
  type AdminColumnMeta,
  type AdminDb,
  type AdminEntity,
  type AdminEntityDescription,
  type AdminFilter,
  type AdminJobSummary,
  type AdminListQuery,
  type AdminMatchingResult,
  type AdminRepo,
  type AdminRow,
  type AdminSort,
  type AdminTable,
  type AdminTableRead,
  type FilterOp,
  type KeysetBound,
  readField,
  rowId,
} from './registry';
export { type AdminRelated, type AdminRelatedList, relatedLists, relatedOf } from './related';
export {
  type AdminOption,
  labelOf,
  type RelationData,
  type RelationNeed,
  relationDataFor,
} from './relations';
export { adminEntitiesOf, adminRepoFor } from './repo-entity';
export { type AdminResource, type AdminResourceOptions, adminResource, repoOf } from './resource';
export type { AdminFieldOverride } from './resource-fields';
export type {
  AdminFormGroupOptions,
  AdminSection,
  AdminSectionOptions,
} from './resource-layout';
export type {
  AdminColumnComponent,
  AdminColumnRenderProps,
  AdminComputedColumn,
  AdminComputedColumnOptions,
  AdminRenderer,
  AdminRowScope,
  AdminScope,
  AdminScopeOptions,
  AdminScopeWhere,
} from './resource-list';
export {
  type AdminRouteConfig,
  type AdminRouteMatch,
  adminRouteConfig,
  adminRouteFor,
  adminRouteMatch,
  adminRoutes,
} from './routes';
export { ROW_CHANGED_REASON, rowVersion, VERSION_FIELD } from './row-version';
export {
  type AdminRouteRequest,
  type AdminRouteResponse,
  type AdminScreen,
  guardedScreen,
} from './screen-frame';
export {
  type AdminSearchHit,
  type AdminSearchInput,
  type AdminSearchResult,
  adminSearch,
} from './search';
export { type AdminTestCtxInput, adminTestCtx } from './test-ctx';
export type {
  AdminBranding,
  ThemeAttributes,
  ThemeMode,
  ThemeTokenRef,
} from './theme';
export { type ValidationIssue, type ValidationResult, validateInput } from './validate';
export type { SelectOption, WidgetContext, WidgetProps } from './widget-value';
export { optionLabel, Widget, type WidgetInput } from './widgets';
