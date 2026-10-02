// The two writes an action makes from a screen: ONE row, posted at the row's URL (its form, when
// it takes input, is that URL asked for the action), and a BATCH, posted at the list's URL whose
// query string is the filter "all matching" means. Both decide through the gate first and render
// what it answered — a 422 form with the schema's issues, a 409 for a row the action's `when`
// excludes, a 403 for a refusal, and an honest count of what a batch did.

import { t } from '@ultimat3/i18n';
import { Button, Card, ErrorState, Link } from '@ultimat3/ui';
import { AdminActionForm } from './action-form';
import { actionButtons } from './action-gate';
import {
  ACTION_INPUT_PREFIX,
  actionInputFields,
  decodeActionInput,
  postedActionInput,
} from './action-input';
import { actionLabelKey } from './action-label';
import { invokeRowAction } from './action-row';
import { BATCH_OPERATION, OPERATION_FIELD } from './actions';
import type { AdminApp } from './admin';
import styles from './admin.module.scss';
import { type AdminBatchResult, type BatchSelection, batchPlan, runAdminBatch } from './batch';
import { BATCH_IDS_FIELD, BATCH_SELECTION_FIELD } from './batch-bar';
import { batchEnqueue } from './batch-job';
import { posted } from './form-decode';
import { listHref, pageRequestOf } from './list-request';
import { findRow } from './list-scope';
import { confirmationToken } from './permissions';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';
import { type AdminRouteRequest, type AdminRouteResponse, framed, refused } from './screen-frame';
import type { ValidationIssue } from './validate';

/** Posted by a form that already showed its fields: run now, do not ask again. */
export const STEP_FIELD = '_step';
const RUN_STEP = 'run';
/** Where an "all matching" batch continues from: the last row the previous request reached. */
export const AFTER_FIELD = 'after';

const rowHref = (app: AdminApp, resource: AdminResource, id: string): string =>
  `${app.basePath}${resource.path}/${id}`;

/** A posted name repeated once per value — the checked rows. */
const postedList = (form: Readonly<Record<string, unknown>>, name: string): readonly string[] => {
  if (!Object.hasOwn(form, name)) return [];
  const value = form[name];
  const list: readonly unknown[] = Array.isArray(value) ? value : [value];
  return list.filter((one): one is string => typeof one === 'string' && one !== '');
};

/** The 409 a row the action does not apply to is answered with: the error, and the way back. */
function notApplicable(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  error: Error,
  back: string,
): AdminRouteResponse {
  return framed(
    app,
    request,
    resource.titleKey,
    <>
      <ErrorState error={error} />
      <Link href={back}>{t('admin.actions.back')}</Link>
    </>,
    409,
  );
}

/** One row's action form: `GET <row>?action=<name>`, and its refused post. */
export async function rowActionForm(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  action: AdminAction,
  values: Readonly<Record<string, string>>,
  issues: readonly ValidationIssue[],
  status = 200,
): Promise<AdminRouteResponse> {
  const id = request.params['id'] ?? '';
  const href = rowHref(app, resource, id);
  return framed(
    app,
    request,
    resource.titleKey,
    <AdminActionForm
      action={action}
      href={href}
      operation="action"
      values={values}
      issues={issues}
      confirmation={action.destructive === true ? confirmationToken(resource.name, id) : null}
      subject={t('admin.actions.subject.row', { id })}
      cancelHref={href}
    />,
    status,
  );
}

/**
 * The form of `?action=<name>` on a row — only for an action the actor may run on THIS row, so a
 * link to a form is never a way round a hidden button. Anything else is the row's 404.
 */
export async function rowActionFormScreen(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  name: string,
  missing: () => AdminRouteResponse,
): Promise<AdminRouteResponse> {
  const action = resource.actions.find((declared) => declared.name === name);
  if (action === undefined) return missing();
  const id = request.params['id'] ?? '';
  const row = await findRow(resource, request.ctx.actor, id);
  if (row === null) return missing();
  // The button's own decision: a form for an action this row would not show is no form at all.
  const offered = actionButtons({
    actions: [action],
    actor: request.ctx.actor,
    authz: request.ctx.authz,
    subject: { entity: resource.name, id, row },
    sealed: resource.secretFields.map((field) => field.name),
  });
  if (offered.length === 0) return missing();
  return rowActionForm(app, request, resource, action, {}, []);
}

/** A posted action on one row: decided by the same gate that decided whether its button rendered. */
export async function rowActionWrite(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  form: Readonly<Record<string, unknown>>,
  missing: () => AdminRouteResponse,
): Promise<AdminRouteResponse> {
  const id = request.params['id'] ?? '';
  // The posted name, resolved against the actions `defineAdmin()` attached to THIS resource —
  // "which operation is this?" is answered before "may this actor run it?".
  const action = resource.actions.find((declared) => declared.name === posted(form, 'name'));
  if (action === undefined) return missing();
  const result = await invokeRowAction({
    resource,
    action,
    id,
    ctx: request.ctx,
    input: decodeActionInput(action, form),
    confirmation: posted(form, 'confirmation'),
  });
  const href = rowHref(app, resource, id);
  if (result.ok) return { kind: 'redirect', location: href };
  if (result.kind === 'not-applicable') {
    return notApplicable(app, request, resource, result.error, href);
  }
  if (result.kind === 'invalid') {
    return rowActionForm(
      app,
      request,
      resource,
      action,
      postedActionInput(action, form),
      result.issues,
      422,
    );
  }
  // A destructive action with a form, posted with the wrong token: the form again, not a 403 —
  // the operator holds the grant and mistyped.
  if (result.confirmationRequired && actionInputFields(action).length > 0) {
    return rowActionForm(app, request, resource, action, postedActionInput(action, form), [], 422);
  }
  return refused(app, request, resource.titleKey, result.decision);
}

/** What a batch result page says, outcome by outcome. */
function batchResult(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  action: AdminAction,
  result: AdminBatchResult,
  again: readonly (readonly [string, string])[],
): AdminRouteResponse {
  const list = listHref(app.basePath, resource);
  const terms: readonly (readonly [string, number])[] = [
    ['admin.batch.done', result.done],
    ['admin.batch.refused', result.refused],
    ['admin.batch.failed', result.failed],
    ['admin.batch.queued', result.queued],
    ['admin.batch.remaining', result.remaining],
  ];
  return framed(
    app,
    request,
    resource.titleKey,
    <Card header={<h2>{t(actionLabelKey(action))}</h2>}>
      <dl class={styles['counts']}>
        {terms.map(([key, count]) => (
          <>
            <dt>{t(key)}</dt>
            <dd>{String(count)}</dd>
          </>
        ))}
      </dl>
      {result.rows.length === 0 ? null : (
        <ul class={styles['list']}>
          {result.rows.map((row) => (
            <li>
              <a href={rowHref(app, resource, row.id)}>{row.id}</a>{' '}
              <span data-outcome={row.outcome}>{t(row.reason)}</span>
            </li>
          ))}
        </ul>
      )}
      {result.remaining === 0 || (result.after === null && action.matching === undefined) ? null : (
        // The rest of an "all matching" batch: the same post, from where this one stopped — or,
        // for a set-based one, the same post again: the set it reads has already shrunk.
        <form
          class={styles['actionForm']}
          method="post"
          action={new URL(request.url).pathname + new URL(request.url).search}
        >
          <input type="hidden" name={OPERATION_FIELD} value={BATCH_OPERATION} />
          <input type="hidden" name="name" value={action.name} />
          <input type="hidden" name={BATCH_SELECTION_FIELD} value="all" />
          {result.after === null ? null : (
            <input type="hidden" name={AFTER_FIELD} value={result.after} />
          )}
          {again.map(([name, value]) => (
            <input type="hidden" name={name} value={value} />
          ))}
          <Button type="submit" size="sm" variant="secondary">
            {t('admin.batch.continue', { count: result.remaining })}
          </Button>
        </form>
      )}
      <Link href={list}>{t('admin.batch.back')}</Link>
    </Card>,
  );
}

/**
 * A batch posted from the list's bar. The first post of an action that takes input, or that is
 * destructive, answers with its form — the confirmation is a server round trip — and the second,
 * `_step=run`, runs it.
 */
export async function batchWrite(
  app: AdminApp,
  request: AdminRouteRequest,
  resource: AdminResource,
  form: Readonly<Record<string, unknown>>,
  missing: () => AdminRouteResponse,
): Promise<AdminRouteResponse> {
  const action = resource.actions.find(
    (declared) => declared.name === posted(form, 'name') && declared.batch !== undefined,
  );
  if (action === undefined) return missing();
  const url = new URL(request.url);
  const all = posted(form, BATCH_SELECTION_FIELD) === 'all';
  const after = posted(form, AFTER_FIELD);
  const ids = postedList(form, BATCH_IDS_FIELD);
  const selection: BatchSelection = all
    ? {
        kind: 'all',
        // The list's own URL grammar: a parameter it does not derive is refused there, by name.
        request: pageRequestOf(resource, url),
        ...(after === undefined ? {} : { after }),
      }
    : { kind: 'ids', ids };
  // What the form posts back: the selection, as it was.
  const hidden: readonly (readonly [string, string])[] = [
    [BATCH_SELECTION_FIELD, all ? 'all' : 'checked'],
    ...(all ? [] : ids.map((id) => [BATCH_IDS_FIELD, id] as const)),
    ...(after === undefined ? [] : [[AFTER_FIELD, after] as const]),
    [STEP_FIELD, RUN_STEP],
  ];
  const href = url.pathname + url.search;
  const values = postedActionInput(action, form);
  const formOf = (
    token: string | null,
    count: number | null,
    issues: readonly ValidationIssue[],
    status: number,
  ): AdminRouteResponse =>
    framed(
      app,
      request,
      resource.titleKey,
      <AdminActionForm
        action={action}
        href={href}
        operation={BATCH_OPERATION}
        values={values}
        issues={issues}
        confirmation={token}
        subject={
          count === null
            ? t(all ? 'admin.batch.subject.all' : 'admin.batch.subject.checked', {
                count: ids.length,
              })
            : t('admin.batch.subject.count', { count })
        }
        hidden={hidden}
        cancelHref={href}
      />,
      status,
    );

  const run = posted(form, STEP_FIELD) === RUN_STEP;
  const asks = actionInputFields(action).length > 0;
  if (!run && asks && action.destructive !== true) return formOf(null, null, [], 200);

  const result = await runAdminBatch({
    resource,
    action,
    ctx: request.ctx,
    selection,
    input: decodeActionInput(action, form),
    confirmation: posted(form, 'confirmation'),
    ...(batchPlan(action) === null ? {} : { enqueue: batchEnqueue(app.basePath) }),
  });
  if (result.ok) {
    return batchResult(app, request, resource, action, result, [
      ...Object.entries(values).map(
        ([name, value]) => [`${ACTION_INPUT_PREFIX}${name}`, value] as const,
      ),
    ]);
  }
  if (result.kind === 'denied') return refused(app, request, resource.titleKey, result.decision);
  if (result.kind === 'confirm') {
    return formOf(result.token, result.count, [], run ? 422 : 200);
  }
  return formOf(null, null, result.issues, 422);
}
