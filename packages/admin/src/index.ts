// The public surface of @ultimat3/admin: the generated app admin, and the /_x dev dashboard.
// Explicit exports only — a barrel that re-exports everything is how internal helpers become
// someone's dependency.

export { AdminActionForm, type AdminActionFormProps } from './action-form';
export {
  ACTION_NOT_APPLICABLE_REASON,
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
export {
  ACTION_INPUT_PREFIX,
  type ActionInputControl,
  type ActionInputField,
  actionInputFields,
  decodeActionInput,
} from './action-input';
export { invokeRowAction, type RowActionInput } from './action-row';
export {
  ACTION_OPERATION,
  ACTION_PARAM,
  AdminActions,
  type AdminActionsProps,
  actionFormHref,
  BATCH_OPERATION,
  DELETE_OPERATION,
  OPERATION_FIELD,
} from './actions';
export {
  type AdminRequestActor,
  ANONYMOUS_ADMIN_ACTOR,
  adminActorFrom,
  requestActor,
} from './actor';
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
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  type AuditCursor,
  type AuditDraft,
  type AuditEntry,
  type AuditFieldDiff,
  type AuditLog,
  type AuditLogOptions,
  type AuditOutcome,
  type AuditQuery,
  type AuditSink,
  auditCursorOf,
  auditEntry,
  deniedDraft,
  diffRows,
  memoryAuditLog,
  REDACTED,
} from './audit';
export {
  type PostgresAuditLogOptions,
  postgresAuditLog,
  SQL_ADMIN_AUDIT_INSERT,
} from './audit-pg';
export { ADMIN_AUDIT_TABLE, SQL_ADMIN_AUDIT_TABLE } from './audit-schema';
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
  type AdminBatchAnswer,
  type AdminBatchInput,
  type AdminBatchResult,
  BATCH_NOT_OFFERED_REASON,
  BATCH_QUEUED_REASON,
  type BatchEnqueue,
  type BatchRow,
  type BatchRowOutcome,
  type BatchSelection,
  batchConfirmationToken,
  batchPlan,
  MAX_BATCH_QUEUED_ROWS,
  MAX_BATCH_ROWS,
  runAdminBatch,
} from './batch';
export {
  AdminBatchBar,
  type AdminBatchBarProps,
} from './batch-bar';
export {
  ADMIN_BATCH_JOB,
  batchEnqueue,
} from './batch-job';
export { BATCH_MATCHING_REASON, matchingConfirmationToken } from './batch-matching';
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
export {
  type AdminActionDescription,
  type AdminDescription,
  type AdminResourceDescription,
  type AdminRouteDescription,
  type AdminScopeDescription,
  type AdminSectionDescription,
  describeAdmin,
} from './describe';
export {
  AdminDetail,
  type AdminDetailProps,
  HISTORY_PARAM,
} from './detail';
export {
  type AdminColumnFacts,
  type AdminColumnReference,
  adminColumnsOf,
  adminSealedColumnsOf,
} from './entity-columns';
// The /_x dashboard is NOT re-exported here — it has its own door, `@ultimat3/admin/dev`, so a
// host that only mounts the dev panels never loads a production admin component.
export {
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_TITLES,
  AdminActionDuplicateError,
  AdminActionNotApplicableError,
  AdminEntityUnknownError,
  type AdminErrorCode,
  type AdminErrorParts,
  AdminFieldUnsupportedError,
  AdminFilterInvalidError,
  AdminMountMissingError,
  AdminPagePathInvalidError,
  AdminPageUnguardedError,
  AdminPolicyMissingError,
  AdminRepoUnboundError,
  adminErrorFrom,
  DevDashboardInProdError,
  DevSourceUnavailableError,
} from './errors';
export {
  type AdminField,
  type AdminFieldType,
  type AdminFilterKind,
  type AdminWidget,
  fieldTypeFromColumn,
  filterable,
  filterKindFor,
  listable,
  searchable,
  sortable,
  WIDGET_BY_FIELD_TYPE,
  widgetFor,
} from './fields';
export { AdminForm, type AdminFormProps, issueText } from './form';
export { currencyFieldOf, decodeForm, posted } from './form-decode';
export { JOB_MANAGE, JOB_READ } from './jobs/job-actions';
export { JOB_ENTITY } from './jobs/job-entities';
export { JOBS_PATH, jobRowScope } from './jobs/job-resources';
export { AdminLayout, type AdminLayoutProps, actorLabel } from './layout';
export { AdminList, type AdminListProps } from './list';
export { type ResourceColumnsInput, resourceColumns } from './list-columns';
export { AdminFilterBar, type AdminFilterBarProps } from './list-filter-bar';
export {
  type AskedFilter,
  checkedFilter,
  declaredFilters,
  FILTER_PREFIX,
  filterOpsOf,
  filterParam,
  knownFilterParams,
} from './list-filters';
export {
  CURSOR_PARAM,
  type ListLocation,
  listHref,
  pageRequestOf,
  SCOPE_PARAM,
  SORT_PARAM,
} from './list-request';
export {
  type AdminListRequest,
  findRow,
  type ListWhere,
  listWhere,
  rowWhere,
  scopeCounts,
  scopeNamed,
} from './list-scope';
export { AdminScopeTabs, type AdminScopeTabsProps } from './list-scope-tabs';
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
export {
  ADMIN_MOUNTS,
  adminMountAt,
  adminMounts,
  clearAdminMounts,
  registerAdminMount,
} from './mounts';
export { adminNav, type NavGroup, type NavItem, type NavOptions, visibleNav } from './nav';
export { AdminPageDenied, auditRefusal } from './page-guard';
export {
  type AdminCustomPage,
  type AdminPageComponent,
  type AdminPageProps,
  pageNavItems,
  pagePermissions,
  pageRoutes,
} from './pages';
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
  computedRow,
  FILTER_OPS,
  type FilterOp,
  type KeysetBound,
  type RegisteredEntity,
  type RegisteredTable,
  readField,
  rowId,
} from './registry';
export {
  type AdminRelated,
  type AdminRelatedList,
  RELATED_PAGE_SIZE,
  relatedLists,
  relatedOf,
} from './related';
export {
  type AdminLookupRequest,
  type AdminLookupResult,
  type AdminOption,
  adminLookup,
  LOOKUP_SELECT_MAX,
  labelOf,
  type RelationData,
  type RelationNeed,
  relationNeeds,
  relationsFor,
} from './relations';
export { ComputedCell, TRUNCATE_AT } from './renderers';
export { adminEntitiesOf, adminRepoFor, adminTablesOf } from './repo-entity';
export {
  type AdminResource,
  type AdminResourceOptions,
  adminResource,
  repoOf,
  resourceFor,
} from './resource';
export type { AdminFieldOverride } from './resource-fields';
export {
  type AdminFormGroupOptions,
  type AdminSection,
  type AdminSectionOptions,
  DEFAULT_SECTION_KEY,
} from './resource-layout';
export {
  ADMIN_RENDERERS,
  type AdminColumnComponent,
  type AdminColumnRenderProps,
  type AdminComputedColumn,
  type AdminComputedColumnOptions,
  type AdminRenderer,
  type AdminRowScope,
  type AdminScope,
  type AdminScopeOptions,
  type AdminScopeWhere,
  LOOKUP_SEGMENT,
} from './resource-list';
export {
  type AdminRouteConfig,
  type AdminRouteMatch,
  adminRouteConfig,
  adminRouteFor,
  adminRouteMatch,
  adminRoutes,
} from './routes';
export { ROW_OUT_OF_SCOPE_REASON } from './row-scope-write';
export {
  type AdminRouteRequest,
  type AdminRouteResponse,
  type AdminScreen,
  guardedScreen,
  lookupHref,
  widgetContextOf,
} from './screen-frame';
export { type OperationDecision, OperationMatrix, operationMatrix } from './screen-home';
export {
  type AdminSearchHit,
  type AdminSearchInput,
  type AdminSearchResult,
  adminSearch,
} from './search';
export { type AdminTestCtxInput, adminTestCtx } from './test-ctx';
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
  type GuardedField,
  type SelectOption,
  type WidgetContext,
  type WidgetProps,
  widgetProps,
} from './widget-value';
export { optionLabel, Widget, type WidgetInput } from './widgets';
