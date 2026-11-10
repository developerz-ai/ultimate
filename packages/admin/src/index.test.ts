// The barrel's own shape: what 25.0.0 took off it stays off. The audit table's DDL is published
// ONCE, by the `@ultimat3/admin/schema` leaf the boot installs from (`cli/src/framework-schema.ts`);
// the insert is `postgresAuditLog`'s alone, and `REDACTED` is core's.
import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import * as schema from './audit-schema';
import * as errorGroups from './error-groups';
import * as barrel from './index';

// v31 (D10): the barrel is the app API. Screen parts, URL grammar, codecs and installers are
// internal — a name here back on `.` is a second door someone will depend on.
const INTERNAL = [
  'ACTION_INPUT_PREFIX',
  'ACTION_NOT_APPLICABLE_REASON',
  'ACTION_OPERATION',
  'ACTION_PARAM',
  'ADMIN_BATCH_JOB',
  'ADMIN_ERROR_CODES',
  'ADMIN_ERROR_TITLES',
  'ADMIN_IMPERSONATE',
  'ADMIN_OPERATIONS',
  'ADMIN_RENDERERS',
  'ANONYMOUS_ADMIN_ACTOR',
  'AUDIT_PAGE_DEFAULT',
  'AUDIT_PAGE_MAX',
  'AdminActionForm',
  'AdminBatchBar',
  'AdminFilterBar',
  'AdminScopeTabs',
  'AdminViewWriteError',
  'BATCH_MATCHING_REASON',
  'BATCH_NOT_OFFERED_REASON',
  'BATCH_OPERATION',
  'CONFIRMATION_REQUIRED_REASON',
  'CURSOR_PARAM',
  'ComputedCell',
  'DEFAULT_SECTION_KEY',
  'DELETE_OPERATION',
  'FILTER_OPS',
  'FILTER_PREFIX',
  'JOBS_PATH',
  'JOB_ENTITY',
  'LOOKUP_SEGMENT',
  'LOOKUP_SELECT_MAX',
  'OPERATION_FIELD',
  'OperationMatrix',
  'RELATED_PAGE_SIZE',
  'ROW_OUT_OF_SCOPE_REASON',
  'SCOPE_PARAM',
  'SORT_PARAM',
  'TRUNCATE_AT',
  'VIEW_OPERATIONS',
  'WIDGET_BY_FIELD_TYPE',
  'actionDecisions',
  'actionFormHref',
  'actionInputFields',
  'adminBranding',
  'adminColumnsOf',
  'adminErrorFrom',
  'adminLookup',
  'adminMountAt',
  'adminNav',
  'adminPermissionFor',
  'adminSealedColumnsOf',
  'adminTablesOf',
  'adminToolDecisions',
  'anonymousAuthz',
  'assertMoney',
  'assertZone',
  'auditEntry',
  'auditRefusal',
  'batchConfirmationToken',
  'batchEnqueue',
  'checkedFilter',
  'computedRow',
  'currencyFieldOf',
  'declaredFilters',
  'decodeActionInput',
  'decodeAdminCursor',
  'decodeForm',
  'defaultBranding',
  'describeAdmin',
  'encodeAdminCursor',
  'fetchPage',
  'fieldTypeFromColumn',
  'filterKindFor',
  'filterOpsOf',
  'filterParam',
  'isAllowed',
  'issueText',
  'knownFilterParams',
  'listQuery',
  'lookupHref',
  'matchingConfirmationToken',
  'operationMatrix',
  'pageNavItems',
  'registerAdminMount',
  'relationNeeds',
  'requestActor',
  'resourceColumns',
  'resourceFor',
  'rowWhere',
  'scopeCounts',
  'scopeNamed',
  'themeAttributes',
  'widgetContextOf',
  'widgetFor',
  'widgetProps',
] as const;

describe('@ultimat3/admin public surface', () => {
  test('no SQL on the barrel — the DDL has one import path, the /schema subpath', () => {
    expect(Object.keys(barrel).filter((name) => name.startsWith('SQL_'))).toEqual([]);
    expect(barrel).not.toHaveProperty('ADMIN_AUDIT_TABLE');
    expect(Object.keys(schema).sort()).toEqual([
      'ADMIN_AUDIT_TABLE',
      'ERROR_GROUPS_TABLE',
      'SQL_ADMIN_AUDIT_TABLE',
      'SQL_ERROR_GROUPS_TABLE',
    ]);
    expect(barrel).not.toHaveProperty('ERROR_GROUPS_TABLE');
  });

  test('the error-groups sink has one door, a subpath no screen rides', () => {
    // Every role installs the sink; on the barrel it would carry every admin screen into a worker.
    expect(barrel).not.toHaveProperty('errorGroupsSink');
    expect(barrel).not.toHaveProperty('postgresErrorGroupsStore');
    expect(typeof errorGroups.errorGroupsSink).toBe('function');
    expect(typeof barrel.errorGroupsPages).toBe('function');
  });

  test("the redaction marker is core's, never a second constant here", () => {
    expect(barrel).not.toHaveProperty('REDACTED');
  });

  test('v31: internals stay off the barrel', () => {
    const surface: Record<string, unknown> = barrel;
    expect(INTERNAL.filter((name) => surface[name] !== undefined)).toEqual([]);
  });

  test('the adapter door carries types only — no runtime value rides it', () => {
    expect(Object.keys(adapter)).toEqual([]);
  });
});
