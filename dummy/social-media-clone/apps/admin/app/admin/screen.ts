// What one dashboard screen needs, resolved before a single element is built. A route has no
// `load` seam, so the page component is `async` and awaits this — keeping the awaiting here means
// the components below stay pure functions of props and are testable without a request.

import {
  ADMIN_OPERATIONS,
  type AdminActionButton,
  type AdminDecision,
  type AdminOperation,
  type AdminRow,
  actionButtons,
  adminList,
  decideAll,
  decideOperation,
  type NavGroup,
  permissionsForOperation,
} from '@ultimat3/admin';
import { localeConfig, t } from '@ultimat3/i18n';
import { currentAdminActor } from './actor';
import { admin, adminCtxForRequest } from './admin';

/** One cell, one column. `labelKey` is the entity-derived i18n key, never a hand-written header. */
export interface ScreenColumn {
  readonly name: string;
  readonly labelKey: string;
}

/**
 * One table row: what it prints, and WHICH row it is. The id is here because an action form has to
 * name its subject — a toolbar button with no id is a control that cannot act, which is what this
 * screen shipped until 2026-08.
 */
export interface ResourceRow {
  readonly id: string;
  readonly cells: readonly string[];
}

/** One row of an operation matrix: the decision the dashboard renders AND the call obeys. */
export interface OperationDecision {
  readonly operation: AdminOperation;
  readonly allowed: boolean;
  readonly permissions: readonly string[];
  readonly reason: string;
}

export interface ResourceScreen {
  readonly name: string;
  readonly titleKey: string;
  /** Non-null when the actor may not even list this resource; the table is absent, not empty. */
  readonly denial: AdminDecision | null;
  readonly columns: readonly ScreenColumn[];
  readonly rows: readonly ResourceRow[];
  /** Only the buttons this actor may press. A denied action never reaches this array. */
  readonly buttons: readonly AdminActionButton[];
  readonly matrix: readonly OperationDecision[];
  readonly total: number;
}

/**
 * A timestamp never renders without an explicit IANA zone — there is no ambient default here or
 * anywhere else, and a server formatting in its own zone tells a reader in another one the wrong
 * day. The actor's zone when the request has one, UTC when it does not.
 *
 * The LOCALE is the actor's too. It was the literal `'en'` until 2026-08, beside a `timeZone` read
 * off the actor — so an operator whose dashboard was otherwise translated read every date in
 * American order. Same for `—`, `yes` and `no`: three user-facing strings that never went through
 * `t()` and therefore had no translation to be missing.
 */
const cell = (value: unknown, locale: string, timeZone: string): string => {
  if (value === null || value === undefined) return t('admin.cell.empty');
  if (value instanceof Date) {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(value);
  }
  if (typeof value === 'boolean') return t(value ? 'admin.cell.yes' : 'admin.cell.no');
  const text = String(value);
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
};

/** Every operation with its decision. This IS the view-only proof, rendered rather than asserted. */
export const operationMatrix = (name: string): readonly OperationDecision[] => {
  const resource = admin.resource(name);
  const ctx = adminCtxForRequest();
  return ADMIN_OPERATIONS.map((operation) => {
    const decision = decideOperation(resource, operation, ctx);
    return {
      operation,
      allowed: decision.allowed,
      permissions: permissionsForOperation(name, operation),
      reason: decision.reason,
    };
  });
};

export const resourceScreen = async (name: string, limit = 25): Promise<ResourceScreen> => {
  const resource = admin.resource(name);
  const ctx = adminCtxForRequest();
  const { actor } = currentAdminActor();
  const timeZone = actor?.timeZone ?? 'UTC';
  // The app's declared default, read back off the framework — never a second literal beside the
  // one in `app.config.ts`.
  const locale = actor?.locale ?? localeConfig().fallback;
  const matrix = operationMatrix(name);
  const columns = resource.listFields.map((field) => ({
    name: field.name,
    labelKey: field.labelKey,
  }));
  const buttons = actionButtons({
    actions: resource.actions,
    actor: ctx.actor,
    authz: ctx.authz,
    subject: { entity: name },
  });

  const page = await adminList<AdminRow>(resource, ctx, { limit });
  if (!page.ok) {
    return {
      name,
      titleKey: resource.titleKey,
      denial: page.decision,
      columns,
      rows: [],
      buttons,
      matrix,
      total: 0,
    };
  }

  return {
    name,
    titleKey: resource.titleKey,
    denial: null,
    columns,
    rows: page.page.rows.map((row) => ({
      id: String(row[resource.idField] ?? ''),
      cells: columns.map((column) => cell(row[column.name], locale, timeZone)),
    })),
    buttons,
    matrix,
    total: page.page.rows.length,
  };
};

/** The nav for THIS actor, with everything they cannot open already removed. */
export const visibleNavFor = (): readonly NavGroup[] => admin.navFor(adminCtxForRequest());

/**
 * The gate for a built-in page — jobs, the audit log, or this app's own ops screen. Same pair as
 * every other surface (`admin:read` + the subject's own `:read`) through the same `decideAll`, so a
 * page that is not a resource still cannot invent its own answer.
 */
export const pageDecision = (subject: string): AdminDecision => {
  const ctx = adminCtxForRequest();
  return decideAll(ctx.authz, permissionsForOperation(subject, 'list'), ctx.actor, {
    entity: subject,
  });
};
