// What every mounted screen shares: the shape of its request and its answer, the shell it is
// framed in, and the refusal it renders. A screen DECIDES first — through `crud.ts`,
// `action-gate.ts` or `page-guard.tsx` — and only then builds a body, so the frame is the one
// place a status meets a document.

import { localeConfig, t } from '@ultimat3/i18n';
import { ErrorState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp, AdminRoute } from './admin';
import { type AdminDecision, decideAll } from './authz';
import { type CrudCtx, canOperate } from './crud';
import { AdminFilterInvalidError } from './errors';
import { AdminLayout } from './layout';
import { AdminPageDenied, auditRefusal } from './page-guard';
import type { AdminPageProps } from './pages';
import type { RelationData } from './relations';
import type { AdminResource } from './resource';
import { LOOKUP_SEGMENT } from './resource-list';
import type { WidgetContext } from './widget-value';

/** One request to one admin route: a GET, or the form a screen posted back at itself. */
export interface AdminRouteRequest extends AdminPageProps {
  readonly method: 'GET' | 'POST';
  /** The parsed form. `null` on a GET; a POST with no fields is `{}`. */
  readonly form: Readonly<Record<string, unknown>> | null;
}

export type AdminRouteResponse =
  | {
      readonly kind: 'document';
      readonly status: number;
      /** The framed screen: shell, nav for this actor, and the body. */
      readonly body: JSX.Element;
    }
  /** A write that worked: the browser is sent to the row or the list it changed. Always a 303. */
  | { readonly kind: 'redirect'; readonly location: string };

/** A mounted screen. `routes.ts` is the only thing that hands one to a host. */
export type AdminScreen = (request: AdminRouteRequest) => Promise<AdminRouteResponse>;

/**
 * The zone and locale every formatter on a screen reads — the ACTOR's, never the server's — and
 * what the page read of the resources it references. `relations` is the whole of it: a widget
 * shows a label or an option list the page already holds, and never reads a row of its own.
 */
export function widgetContextOf(
  app: AdminApp,
  ctx: CrudCtx,
  relations: ReadonlyMap<string, RelationData> = new Map(),
): WidgetContext {
  const target = (entity: string): AdminResource | undefined =>
    app.resources.find((resource) => resource.name === entity);
  return {
    timeZone: ctx.actor.timeZone ?? 'UTC',
    // The app's declared default, read back off the framework — never a second literal.
    locale: ctx.actor.locale ?? localeConfig().fallback,
    // The route table is the app's; a widget three layers down gets a link or no link.
    hrefFor: (entity, id) => {
      const found = target(entity);
      return found === undefined ? null : `${app.basePath}${found.path}/${id}`;
    },
    labelFor: (entity, id) => relations.get(entity)?.labels.get(id),
    optionsFor: (entity) => relations.get(entity)?.options ?? null,
    lookupHref: (entity) => {
      const found = target(entity);
      // Only a resource whose list this actor may read has a lookup to send them to.
      return found === undefined || !canOperate(found, 'list', ctx)
        ? null
        : lookupHref(app.basePath, found);
    },
  };
}

/** Where a resource's lookup screen lives. One spelling, read by the route table and every link. */
export const lookupHref = (basePath: string, resource: Pick<AdminResource, 'path'>): string =>
  `${basePath}${resource.path}/${LOOKUP_SEGMENT}`;

export function framed(
  app: AdminApp,
  request: AdminRouteRequest,
  /** The screen's `<h1>`. `null` when the body carries its own — a refusal does. */
  titleKey: string | null,
  body: JSX.Element,
  status = 200,
): AdminRouteResponse {
  return {
    kind: 'document',
    status,
    body: (
      <AdminLayout
        app={app}
        nav={app.navFor(request.ctx)}
        currentPath={new URL(request.url).pathname}
        actor={request.ctx.actor}
        {...(titleKey === null ? {} : { title: t(titleKey) })}
      >
        {body}
      </AdminLayout>
    ),
  };
}

/** A refusal the gate already audited: the page names the permission, and the status is 403. */
export function refused(
  app: AdminApp,
  request: AdminRouteRequest,
  titleKey: string,
  decision: AdminDecision,
): AdminRouteResponse {
  return framed(
    app,
    request,
    null,
    <AdminPageDenied titleKey={titleKey} decision={decision} />,
    403,
  );
}

/**
 * A refusal decided HERE rather than inside a crud call — a form's GET, a page — so the audit
 * entry is written here too. The page is the subject: its path is what the row names.
 */
export async function refusedPage(
  app: AdminApp,
  request: AdminRouteRequest,
  route: AdminRoute,
  decision: AdminDecision,
): Promise<AdminRouteResponse> {
  await auditRefusal(request.ctx, route.path, decision);
  return refused(app, request, route.titleKey, decision);
}

/** A URL the admin serves and a thing it does not have: a row that is gone, an unknown action. */
export function missing(
  app: AdminApp,
  request: AdminRouteRequest,
  titleKey: string,
  body: JSX.Element,
): AdminRouteResponse {
  return framed(app, request, titleKey, body, 404);
}

/**
 * The wrapper that makes a screen's authz unskippable: a custom page, the dashboard, jobs, audit
 * and search are all built through it, so "the screen that forgot its policy line" has nowhere to
 * exist. It asks the SAME `decideAll` every CRUD call and every nav item asks, audits the
 * refusal, answers it 403, and only then calls the body. A resource screen is the one thing not
 * built here — `crud.ts` decides those, because only it holds the row a row-level rule reads.
 */
export function guardedScreen(
  app: AdminApp,
  route: AdminRoute,
  body: (request: AdminRouteRequest) => JSX.Element | Promise<JSX.Element>,
): AdminScreen {
  return async (request) => {
    const decision = decideAll(request.ctx.authz, route.permissions, request.ctx.actor);
    if (!decision.allowed) return refusedPage(app, request, route, decision);
    try {
      return framed(app, request, route.titleKey, await body(request));
    } catch (error) {
      // A body that refuses its URL — a parameter it does not answer — is the list's 400: the
      // error, naming what the screen does answer. Anything else is not this frame's to render.
      if (!(error instanceof AdminFilterInvalidError)) throw error;
      return framed(app, request, route.titleKey, <ErrorState error={error} />, 400);
    }
  };
}
