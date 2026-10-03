// The four generated screens of one resource — list, detail, create, edit — and the writes each
// one's forms post back at it. Every one asks `crud.ts` (or the action gate) FIRST and renders
// what it answered: a row-level rule sees the row, a refusal is audited by the gate that made it,
// and no screen holds a decision of its own.

import { t } from '@ultimat3/i18n';
import { ErrorState, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  ACTION_OPERATION,
  ACTION_PARAM,
  BATCH_OPERATION,
  DELETE_OPERATION,
  OPERATION_FIELD,
} from './actions';
import type { AdminApp, AdminRoute } from './admin';
import styles from './admin.module.scss';
import { auditCursorOf } from './audit';
import {
  adminCreate,
  adminDestroy,
  adminDetail,
  adminList,
  adminUpdate,
  canOperate,
  decideOperation,
} from './crud';
import { AdminDetail, HISTORY_PARAM, historyCursorOf, historyCursorText } from './detail';
import { AdminFilterInvalidError } from './errors';
import { AdminForm } from './form';
import { decodeForm, posted } from './form-decode';
import { AdminList } from './list';
import { type ListLocation, listHref, pageRequestOf } from './list-request';
import { type AdminListRequest, findRow, scopeCounts } from './list-scope';
import type { AdminRow } from './registry';
import { relatedLists, relatedOf } from './related';
import { type RelationNeed, relationNeeds, relationsFor } from './relations';
import type { AdminResource } from './resource';
import { ROW_CHANGED_REASON, rowVersion, VERSION_FIELD } from './row-version';
import { batchWrite, rowActionFormScreen, rowActionWrite } from './screen-action';
import {
  type AdminRouteRequest,
  type AdminRouteResponse,
  type AdminScreen,
  framed,
  missing,
  refused,
  refusedPage,
  widgetContextOf,
} from './screen-frame';
import type { ValidationIssue } from './validate';
import type { WidgetContext } from './widget-value';

const rowHref = (app: AdminApp, resource: AdminResource, id: string): string =>
  `${app.basePath}${resource.path}/${id}`;

const idOf = (request: AdminRouteRequest): string => request.params['id'] ?? '';

const notFound = (
  app: AdminApp,
  resource: AdminResource,
  request: AdminRouteRequest,
): AdminRouteResponse =>
  missing(
    app,
    request,
    resource.titleKey,
    <AdminDetail
      resource={resource}
      row={null}
      error={null}
      ctx={widgetContextOf(app, request.ctx)}
      actor={request.ctx.actor}
      authz={request.ctx.authz}
      audit={[]}
      basePath={app.basePath}
    />,
  );

export function listScreen(app: AdminApp, resource: AdminResource): AdminScreen {
  const hrefFor = (location: ListLocation): string => listHref(app.basePath, resource, location);
  return async (request) => {
    // A batch is posted at the list's own URL: its query string is what "all matching" means.
    if (request.method === 'POST') {
      const form = request.form ?? {};
      if (posted(form, OPERATION_FIELD) !== BATCH_OPERATION)
        return notFound(app, resource, request);
      try {
        return await batchWrite(app, request, resource, form, () =>
          notFound(app, resource, request),
        );
      } catch (error) {
        if (!(error instanceof AdminFilterInvalidError)) throw error;
        return framed(app, request, resource.titleKey, <ErrorState error={error} />, 400);
      }
    }
    // Refused BEFORE the URL is read: an actor who may not list the table learns nothing about
    // its filters or scopes from the answer. `adminList` makes and audits the refusal.
    if (!canOperate(resource, 'list', request.ctx)) {
      const denied = await adminList<AdminRow>(resource, request.ctx);
      if (!denied.ok) return refused(app, request, resource.titleKey, denied.decision);
    }
    let asked: AdminListRequest;
    let result: Awaited<ReturnType<typeof adminList<AdminRow>>>;
    try {
      asked = pageRequestOf(resource, new URL(request.url));
      // Inside the same refusal: a repo that cannot answer a predicate the URL grammar allows (a
      // store with one order, a filter it has no column for) refuses it by name too.
      result = await adminList<AdminRow>(resource, request.ctx, asked);
    } catch (error) {
      if (!(error instanceof AdminFilterInvalidError)) throw error;
      // 400, naming what the list does answer — and the way back to it.
      return framed(
        app,
        request,
        resource.titleKey,
        <>
          <ErrorState error={error} />
          <Link href={hrefFor({})}>{t('admin.filter.clear')}</Link>
        </>,
        400,
      );
    }
    if (!result.ok) return refused(app, request, resource.titleKey, result.decision);

    // Everything else the page shows, read beside each other: one count per scope that asked for
    // one, and one read per resource the page references — never one per row.
    const [counts, relations] = await Promise.all([
      scopeCounts(resource, request.ctx.actor),
      relationsFor(
        app.resources,
        request.ctx,
        relationNeeds(result.page.rows, resource.listFields, resource.filters),
      ),
    ]);

    return framed(
      app,
      request,
      resource.titleKey,
      <>
        {canOperate(resource, 'create', request.ctx) ? (
          <div class={styles['toolbar']}>
            <Link appearance="button" href={`${hrefFor({})}/new`}>
              {t('admin.form.create', { entity: t(resource.titleKey) })}
            </Link>
          </div>
        ) : null}
        <AdminList
          resource={resource}
          page={result.page}
          error={null}
          ctx={widgetContextOf(app, request.ctx, relations)}
          actor={request.ctx.actor}
          authz={request.ctx.authz}
          basePath={app.basePath}
          request={asked}
          scope={result.scope}
          counts={counts}
          hrefFor={hrefFor}
        />
      </>,
    );
  };
}

/** The labels, option lists and lookups one row's reference fields need, for a detail or a form. */
const relationsOf = (
  app: AdminApp,
  resource: AdminResource,
  request: AdminRouteRequest,
  row: AdminRow,
  picking: boolean,
): Promise<WidgetContext> =>
  relationsFor(
    app.resources,
    request.ctx,
    relationNeeds([row], resource.fields, picking ? resource.formFields : []),
  ).then((relations) => widgetContextOf(app, request.ctx, relations));

/** A posted action or delete, decided by the same gate that decided whether its button rendered. */
async function detailWrite(
  app: AdminApp,
  resource: AdminResource,
  request: AdminRouteRequest,
  form: Readonly<Record<string, unknown>>,
): Promise<AdminRouteResponse> {
  const id = idOf(request);
  const confirmation = posted(form, 'confirmation');
  const landing = listHref(app.basePath, resource);

  if (posted(form, OPERATION_FIELD) === DELETE_OPERATION) {
    const result = await adminDestroy(resource, request.ctx, id, confirmation);
    if (result.ok) return { kind: 'redirect', location: landing };
    if (result.kind === 'denied') return refused(app, request, resource.titleKey, result.decision);
    return notFound(app, resource, request);
  }

  if (posted(form, OPERATION_FIELD) !== ACTION_OPERATION) return notFound(app, resource, request);
  return rowActionWrite(app, request, resource, form, () => notFound(app, resource, request));
}

/** How many entries of a row's history one detail page shows. Older ones are a link away. */
const HISTORY_PAGE = 20;

/** Two pages' needs as one: each target is still read once for the whole page. */
const mergedNeeds = (
  all: readonly ReadonlyMap<string, RelationNeed>[],
): ReadonlyMap<string, RelationNeed> => {
  const out = new Map<string, { ids: Set<string>; pick: boolean }>();
  for (const needs of all) {
    for (const [entity, need] of needs) {
      const held = out.get(entity) ?? { ids: new Set<string>(), pick: false };
      for (const id of need.ids) held.ids.add(id);
      held.pick ||= need.pick;
      out.set(entity, held);
    }
  }
  return out;
};

export function detailScreen(app: AdminApp, resource: AdminResource): AdminScreen {
  return async (request) => {
    if (request.method === 'POST') {
      return detailWrite(app, resource, request, request.form ?? {});
    }
    const id = idOf(request);
    const url = new URL(request.url);
    const asked = url.searchParams.get(ACTION_PARAM);
    if (asked !== null) {
      return rowActionFormScreen(app, request, resource, asked, () =>
        notFound(app, resource, request),
      );
    }
    const result = await adminDetail<AdminRow>(resource, request.ctx, id);
    if (!result.ok) {
      return result.kind === 'denied'
        ? refused(app, request, resource.titleKey, result.decision)
        : notFound(app, resource, request);
    }
    if (result.row === null) return notFound(app, resource, request);
    const row = result.row;

    // Everything else the page shows, read beside each other: the related resources' own lists,
    // and one keyset page of this row's history — what changed it or was refused, never who read.
    const before = historyCursorOf(url.searchParams.get(HISTORY_PARAM));
    const [related, history] = await Promise.all([
      relatedLists(relatedOf(app.resources, resource), row, request.ctx),
      request.ctx.audit.entries({
        entity: resource.name,
        entityId: id,
        changes: true,
        limit: HISTORY_PAGE,
        // The actor's tenant's entries only, as on the audit screen — a row two orgs may open
        // does not show one org who in the other changed it.
        ...(request.ctx.actor.orgId === undefined ? {} : { orgId: request.ctx.actor.orgId }),
        ...(before === undefined ? {} : { before }),
      }),
    ]);
    // ONE label read per referenced target for the whole page — this row's references and every
    // related row's together.
    const relations = await relationsFor(
      app.resources,
      request.ctx,
      mergedNeeds([
        relationNeeds([row], resource.fields, []),
        ...related.map((list) =>
          relationNeeds(list.page.rows, list.related.resource.listFields, []),
        ),
      ]),
    );
    const older = auditCursorOf(history);
    const self = rowHref(app, resource, id);

    return framed(
      app,
      request,
      resource.titleKey,
      <AdminDetail
        resource={resource}
        row={row}
        error={null}
        ctx={widgetContextOf(app, request.ctx, relations)}
        actor={request.ctx.actor}
        authz={request.ctx.authz}
        audit={history}
        olderHref={
          history.length < HISTORY_PAGE || older === null
            ? null
            : `${self}?${HISTORY_PARAM}=${encodeURIComponent(historyCursorText(older))}`
        }
        related={related}
        relatedHref={(list) =>
          // Through the target's own list grammar — only when the key is one of its filters, or
          // the link would be the unfiltered list.
          list.related.resource.filters.some((field) => field.name === list.filter.field)
            ? listHref(app.basePath, list.related.resource, { scope: null, filters: [list.filter] })
            : listHref(app.basePath, list.related.resource)
        }
        basePath={app.basePath}
        may={{
          update: decideOperation(resource, 'update', request.ctx, id, row).allowed,
          delete: decideOperation(resource, 'delete', request.ctx, id, row).allowed,
        }}
      />,
    );
  };
}

async function form(
  app: AdminApp,
  resource: AdminResource,
  request: AdminRouteRequest,
  mode: 'create' | 'edit',
  values: Readonly<Record<string, unknown>>,
  issues: readonly ValidationIssue[],
  version: string | null,
): Promise<JSX.Element> {
  const list = listHref(app.basePath, resource);
  return (
    <AdminForm
      resource={resource}
      mode={mode}
      values={values}
      issues={issues}
      error={null}
      // A reference input picks from its target: the option list of a small one, read once.
      ctx={await relationsOf(app, resource, request, values, true)}
      action={new URL(request.url).pathname}
      cancelHref={mode === 'create' ? list : rowHref(app, resource, idOf(request))}
      version={version}
    />
  );
}

/** The form-level issue a write against a stale version is re-rendered with. */
const ROW_CHANGED_ISSUE: ValidationIssue = {
  path: VERSION_FIELD,
  message: 'the row was changed after this form was opened',
  messageKey: ROW_CHANGED_REASON,
};

export function createScreen(
  app: AdminApp,
  route: AdminRoute,
  resource: AdminResource,
): AdminScreen {
  return async (request) => {
    if (request.method === 'GET') {
      const decision = decideOperation(resource, 'create', request.ctx);
      if (!decision.allowed) return refusedPage(app, request, route, decision);
      return framed(
        app,
        request,
        resource.titleKey,
        await form(app, resource, request, 'create', {}, [], null),
      );
    }
    const input = decodeForm(resource, request.form ?? {});
    const result = await adminCreate<AdminRow>(resource, request.ctx, input);
    if (result.ok) {
      const id = String(result.row?.[resource.idField] ?? '');
      return { kind: 'redirect', location: rowHref(app, resource, id) };
    }
    if (result.kind === 'denied') return refused(app, request, resource.titleKey, result.decision);
    // A create has no row to have gone missing or stale: neither is an answer it can give.
    if (result.kind !== 'invalid') return notFound(app, resource, request);
    // 422, with what was typed: a refused form that came back empty is a form filled in twice.
    return framed(
      app,
      request,
      resource.titleKey,
      await form(app, resource, request, 'create', input, result.issues, null),
      422,
    );
  };
}

export function editScreen(app: AdminApp, route: AdminRoute, resource: AdminResource): AdminScreen {
  return async (request) => {
    const id = idOf(request);
    const row = await findRow(resource, request.ctx.actor, id);
    if (request.method === 'GET') {
      const decision = decideOperation(resource, 'update', request.ctx, id, row);
      if (!decision.allowed) return refusedPage(app, request, route, decision);
      if (row === null) return notFound(app, resource, request);
      return framed(
        app,
        request,
        resource.titleKey,
        await form(app, resource, request, 'edit', row, [], rowVersion(row)),
      );
    }
    const submitted = request.form ?? {};
    // Decoded against the row as it is: an instant posted back as the minute it was drawn at is
    // left out, not rewritten to that minute. A row that moved on since the form was rendered is
    // refused below on its version, so "as it is" and "as it was drawn" are the same row here.
    const input = decodeForm(resource, submitted, row ?? undefined);
    // A post with no version is not a form this admin rendered: it is refused as stale, never run
    // as an unversioned write — the version is how the form says which row it was looking at.
    const version = posted(submitted, VERSION_FIELD) ?? '';
    const result = await adminUpdate<AdminRow>(resource, request.ctx, id, input, { version });
    if (result.ok) return { kind: 'redirect', location: rowHref(app, resource, id) };
    if (result.kind === 'denied') return refused(app, request, resource.titleKey, result.decision);
    if (result.kind === 'missing') return notFound(app, resource, request);
    if (result.kind === 'stale') {
      // What they typed, over the row as it is NOW, under its current version: saving again is a
      // decision taken with the other edit on screen, not an accident.
      return framed(
        app,
        request,
        resource.titleKey,
        await form(
          app,
          resource,
          request,
          'edit',
          { ...result.row, ...input },
          [ROW_CHANGED_ISSUE],
          result.version,
        ),
        409,
      );
    }
    return framed(
      app,
      request,
      resource.titleKey,
      await form(
        app,
        resource,
        request,
        'edit',
        { ...(row ?? {}), ...input },
        result.issues,
        version,
      ),
      422,
    );
  };
}
