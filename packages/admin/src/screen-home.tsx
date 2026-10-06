// `/admin` — the dashboard: how many rows of each resource this actor may open, the decision behind
// each of its operations, and the app-wide actions. No row is READ here: a figure is one
// `count()` per resource (`screen-home-counts.ts`), never a page of rows per entity per visit.

import { t } from '@ultimat3/i18n';
import { AdminActionForm } from './action-form';
import { actionButtons, invokeAdminAction } from './action-gate';
import { decodeActionInput, postedActionInput } from './action-input';
import { ACTION_OPERATION, ACTION_PARAM, AdminActions, OPERATION_FIELD } from './actions';
import type { AdminApp, AdminRoute } from './admin';
import styles from './admin.module.scss';
import { decideAll } from './authz';
import { canOperate } from './crud';
import { posted } from './form-decode';
import { confirmationToken } from './permissions';
import type { AdminAction } from './registry';
import {
  type AdminRouteRequest,
  type AdminRouteResponse,
  type AdminScreen,
  framed,
  refused,
  refusedPage,
} from './screen-frame';
import { HomeAccess, operationMatrix } from './screen-home-access';
import { resourceCounts } from './screen-home-counts';
import { HomeKpis } from './screen-home-kpis';
import type { ValidationIssue } from './validate';

export { type OperationDecision, OperationMatrix, operationMatrix } from './screen-home-access';

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
    // Counted only over what the actor may list: the size of a table is itself a fact to gate.
    const counts = await resourceCounts(open, request.ctx.actor);
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
        {counts.length === 0 ? null : <HomeKpis basePath={app.basePath} counts={counts} />}
        {open.length === 0 ? null : (
          <HomeAccess
            basePath={app.basePath}
            entries={open.map((resource) => ({
              resource,
              rows: operationMatrix(resource, request.ctx),
            }))}
          />
        )}
      </div>,
    );
  };
}
