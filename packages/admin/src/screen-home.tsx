// `/admin` — the dashboard: every resource this actor may open, the decision behind each of its
// operations, and the app-wide actions. No row is read here: a dashboard that listed five rows of
// every resource would be one query per entity on every visit to the front page.

import { t } from '@ultimat3/i18n';
import { Card } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { AdminActionForm } from './action-form';
import { actionButtons, invokeAdminAction } from './action-gate';
import { decodeActionInput, postedActionInput } from './action-input';
import { ACTION_OPERATION, ACTION_PARAM, AdminActions, OPERATION_FIELD } from './actions';
import type { AdminApp, AdminRoute } from './admin';
import styles from './admin.module.scss';
import { decideAll } from './authz';
import type { CrudCtx } from './crud';
import { canOperate, decideOperation, permissionsForOperation } from './crud';
import { posted } from './form-decode';
import { ADMIN_OPERATIONS, type AdminOperation, confirmationToken } from './permissions';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';
import {
  type AdminRouteRequest,
  type AdminRouteResponse,
  type AdminScreen,
  framed,
  refused,
  refusedPage,
} from './screen-frame';
import type { ValidationIssue } from './validate';

/** One row of an operation matrix: the decision the dashboard renders AND the call obeys. */
export interface OperationDecision {
  readonly operation: AdminOperation;
  readonly allowed: boolean;
  readonly permissions: readonly string[];
  readonly reason: string;
}

/**
 * Every operation the resource OFFERS, with its decision. This IS the view-only proof, rendered
 * rather than asserted. One it does not offer has no row: "denied" would read as a missing grant
 * the operator should ask for, when no grant opens it.
 */
export const operationMatrix = (
  resource: AdminResource,
  ctx: CrudCtx,
): readonly OperationDecision[] =>
  ADMIN_OPERATIONS.filter((operation) => resource.operations.includes(operation)).map(
    (operation) => {
      const decision = decideOperation(resource, operation, ctx);
      return {
        operation,
        allowed: decision.allowed,
        permissions: permissionsForOperation(resource.permission, operation),
        reason: decision.reason,
      };
    },
  );

/**
 * The permission matrix, rendered. A reader can see that `create`, `update` and `delete` are
 * refused and WHICH permission refused them — the same decision the call obeys, not a note about
 * a button that was left out.
 */
export function OperationMatrix(props: {
  readonly rows: readonly OperationDecision[];
}): JSX.Element {
  return (
    <table class={styles['matrix']}>
      <thead>
        <tr>
          <th>{t('admin.matrix.operation')}</th>
          <th>{t('admin.matrix.permissions')}</th>
          <th>{t('admin.matrix.verdict')}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr class={row.allowed ? styles['allowed'] : styles['denied']}>
            <td>{t(`admin.operation.${row.operation}`)}</td>
            <td class={styles['mono']}>{row.permissions.join(' + ')}</td>
            <td>
              {row.allowed
                ? t('admin.matrix.allowed')
                : `${t('admin.matrix.deniedBy')} ${row.reason}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** An app-wide action's POST: the same gate, with no row for a subject. */
async function globalWrite(
  app: AdminApp,
  route: AdminRoute,
  request: AdminRouteRequest,
  form: Readonly<Record<string, unknown>>,
): Promise<AdminRouteResponse> {
  const name = posted(form, 'name') ?? '';
  const action =
    posted(form, OPERATION_FIELD) === ACTION_OPERATION
      ? app.globalActions.find((declared) => declared.name === name)
      : undefined;
  if (action === undefined) {
    return framed(app, request, route.titleKey, <p>{t('admin.actions.unknown')}</p>, 404);
  }
  const confirmation = posted(form, 'confirmation');
  const result = await invokeAdminAction({
    action,
    input: decodeActionInput(action, form),
    actor: request.ctx.actor,
    authz: request.ctx.authz,
    audit: request.ctx.audit,
    requestId: request.ctx.requestId,
    ...(confirmation === undefined ? {} : { confirmation }),
  });
  if (result.ok) return { kind: 'redirect', location: app.basePath };
  if (result.kind === 'invalid') {
    return globalForm(app, route, request, action, postedActionInput(action, form), result.issues);
  }
  // A global action has no row, so its `when` is never asked: only a refusal is left.
  return refused(app, request, route.titleKey, result.decision);
}

/** An app-wide action's own form: `GET /admin?action=<name>`, and its refused post. */
function globalForm(
  app: AdminApp,
  route: AdminRoute,
  request: AdminRouteRequest,
  action: AdminAction,
  values: Readonly<Record<string, string>>,
  issues: readonly ValidationIssue[],
): AdminRouteResponse {
  return framed(
    app,
    request,
    route.titleKey,
    <AdminActionForm
      action={action}
      href={app.basePath}
      operation={ACTION_OPERATION}
      values={values}
      issues={issues}
      confirmation={action.destructive === true ? confirmationToken('admin', '') : null}
      subject={t('admin.actions.subject.app')}
      cancelHref={app.basePath}
    />,
    issues.length === 0 ? 200 : 422,
  );
}

export function homeScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return async (request) => {
    const decision = decideAll(request.ctx.authz, route.permissions, request.ctx.actor);
    if (!decision.allowed) return refusedPage(app, request, route, decision);
    if (request.method === 'POST') return globalWrite(app, route, request, request.form ?? {});
    const asked = new URL(request.url).searchParams.get(ACTION_PARAM);
    if (asked !== null) {
      // Only an action this actor may run: a link to a form is never a way round a missing button.
      const offered = actionButtons({
        actions: app.globalActions,
        actor: request.ctx.actor,
        authz: request.ctx.authz,
      }).some((button) => button.name === asked);
      const action = app.globalActions.find((declared) => declared.name === asked);
      if (!offered || action === undefined) {
        return framed(app, request, route.titleKey, <p>{t('admin.actions.unknown')}</p>, 404);
      }
      return globalForm(app, route, request, action, {}, []);
    }

    const open = app.resources.filter((resource) => canOperate(resource, 'list', request.ctx));
    return framed(
      app,
      request,
      route.titleKey,
      <div class={styles['panel']}>
        <AdminActions
          actions={app.globalActions}
          actor={request.ctx.actor}
          authz={request.ctx.authz}
          href={app.basePath}
        />
        {open.length === 0 ? <p class={styles['note']}>{t('admin.actions.none')}</p> : null}
        {open.map((resource) => (
          <Card
            header={
              <h2>
                <a href={`${app.basePath}${resource.path}`}>{t(resource.titleKey)}</a>
              </h2>
            }
          >
            <OperationMatrix rows={operationMatrix(resource, request.ctx)} />
          </Card>
        ))}
      </div>,
    );
  };
}
