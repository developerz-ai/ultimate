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
export { type DevSourceOptions, defaultDevSources, staticDevSources } from './dev/data';
export type {
  CacheEdgeFact,
  ColumnFact,
  DevSources,
  DriftFact,
  InvalidationFact,
  JobDefFact,
  JobRunFact,
  JobStepFact,
  LiveQueryFact,
  LiveSubscriberFact,
  MailFact,
  ManifestFact,
  PolicyFact,
  QueueFact,
  RequestTrace,
  RouteFact,
  SpanKind,
  SqlResult,
  TableFact,
  TaskFact,
  TimelineSpan,
} from './dev/facts';
export { type DevPanel, type PanelPayload, panelPayload } from './dev/panel';
export { type CachePanelData, cachePanel } from './dev/panel-cache';
export { assertReadOnly, type DbPanelData, dbPanel } from './dev/panel-db';
export { type JobsPanelData, jobsPanel } from './dev/panel-jobs';
export { type LivePanelData, livePanel } from './dev/panel-live';
export { type MailPanelData, mailPanel } from './dev/panel-mail';
export { type ManifestPanelData, manifestPanel } from './dev/panel-manifest';
export { type PolicyPanelData, policyPanel } from './dev/panel-policy';
export { type RoutesPanelData, routesPanel } from './dev/panel-routes';
export { type TimelinePanelData, timelinePanel } from './dev/panel-timeline';
export {
  assertDevOnly,
  DEV_BASE_PATH,
  DEV_PANELS,
  type DevDashboard,
  type DevDashboardOptions,
  devDashboard,
} from './dev/server';
export {
  ADMIN_ERROR_CODES,
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
  type AdminEntity,
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
