// The wrapper that makes a custom page's authz unskippable. `routes.ts` never hands the router
// the author's component — it hands this one, which asks the SAME `decideAll` every CRUD call
// and every nav item asks, audits the refusal, and only then calls the author's code.

import { t } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import type { AdminRoute } from './admin';
import { deniedDraft } from './audit';
import { type AdminDecision, decideAll } from './authz';
import type { AdminPageComponent, AdminPageProps } from './pages';

/**
 * The refusal, rendered as the page. Not a redirect and not a 404: an operator who is missing a
 * grant needs to read WHICH permission refused them, which is the same string the audit row and
 * the `/_x` policy panel carry.
 */
export function AdminPageDenied(props: {
  readonly titleKey: string;
  readonly decision: AdminDecision;
}): JSX.Element {
  return (
    <section class="x-admin-denied" role="alert">
      <h1>{t(props.titleKey)}</h1>
      <p>
        {t('admin.denied.body', {
          permission: props.decision.permission,
          reason: props.decision.reason,
        })}
      </p>
    </section>
  );
}

/**
 * Wrap once, at route-table build time. The author's component is never reachable from
 * `adminRoutes()`, so "the page that forgot its policy line" has nowhere left to exist.
 */
export function guardedPage(route: AdminRoute, component: AdminPageComponent): AdminPageComponent {
  return async (props: AdminPageProps): Promise<JSX.Element> => {
    const decision = decideAll(props.ctx.authz, route.permissions, props.ctx.actor);
    if (!decision.allowed) {
      // The page IS the subject here, so its path is what the audit row names — there is no
      // entity and no row id to key a refused screen by.
      await props.ctx.audit.append(
        deniedDraft({
          requestId: props.ctx.requestId,
          actor: props.ctx.actor,
          operation: 'page',
          kind: 'operation',
          entity: route.path,
          decision,
        }),
      );
      return <AdminPageDenied titleKey={route.titleKey} decision={decision} />;
    }
    return component(props);
  };
}
