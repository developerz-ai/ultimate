// The dashboard's shared views. Pure functions of props — no signals, no fetching, no decisions:
// every screen was already resolved by `screen.ts`, and a view that re-decided anything would be
// the second authz path the admin exists to prevent.

import type { AdminActionButton, NavGroup } from '@ultimat3/admin';
import { confirmationToken } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import { ADMIN_ACTION_ROUTE } from '../../shared/action-route';
import { admin } from './admin';
import type { OperationDecision, ResourceScreen } from './screen';
import styles from './views.module.scss';

export interface AdminShellProps {
  readonly titleKey: string;
  readonly nav: readonly NavGroup[];
  readonly actorLabel: string;
  readonly children?: JSX.Element;
}

export function AdminShell(props: AdminShellProps) {
  return (
    <div class={styles.shell} data-density={admin.theme['data-density']}>
      <aside class={styles.side}>
        <a class={styles.brand} href={admin.basePath}>
          {t(admin.branding.nameKey)}
        </a>
        <p class={styles.actor}>{props.actorLabel}</p>
        {props.nav.map((group) => (
          <nav class={styles.group}>
            <h2 class={styles.groupTitle}>{t(group.labelKey)}</h2>
            <ul class={styles.navList}>
              {group.items.map((item) => (
                <li>
                  <a class={styles.navLink} href={`${admin.basePath}${item.href}`}>
                    {t(item.labelKey)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        {/* `/admin/ops` used to be a raw anchor right here, hard-coded and visible to everyone
            who could open the dashboard — the one link in this sidebar that no permission
            filtered. It is a `pages:` entry now, so it arrives through `props.nav` above with the
            rest, and `visibleNav` drops it for an actor the page would refuse. */}
        {/* The way out. `apps/admin` is a separate surface, so nothing in its own route table
            points back at the app — an operator who opened the dashboard had no link home and
            had to edit the URL bar, which is the same defect as the app having no link IN. */}
        <a class={styles.navLink} href="/">
          {t('admin.backToApp')}
        </a>
      </aside>
      <main class={styles.main}>
        <h1 class={styles.title}>{t(props.titleKey)}</h1>
        {props.children}
      </main>
    </div>
  );
}

/**
 * The permission matrix, rendered. A reader can see that `create`, `update` and `delete` are
 * refused and WHICH permission refused them — the same decision the call obeys, not a note about
 * a button that was left out.
 */
export function OperationMatrix(props: { readonly rows: readonly OperationDecision[] }) {
  return (
    <table class={styles.matrix}>
      <thead>
        <tr>
          <th>{t('admin.matrix.operation')}</th>
          <th>{t('admin.matrix.permissions')}</th>
          <th>{t('admin.matrix.verdict')}</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr class={row.allowed ? styles.allowed : styles.denied}>
            <td>{t(`admin.operation.${row.operation}`)}</td>
            <td class={styles.mono}>{row.permissions.join(' + ')}</td>
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

/**
 * The allowed actions for ONE row, as native form submits. `hydrate: 'never'` is kept — a form
 * POST is the browser's own client — and the target is the route `runAdminAction` derives, so the
 * button that `actionButtons()` allowed reaches the `invokeAdminAction` that decides it again.
 *
 * Until 2026-08 these were `type="button"` with no handler and no enclosing form on a page that
 * never hydrated: a control that could not act, on top of an `invokeAdminAction` nothing called.
 */
export function RowActions(props: {
  readonly entity: string;
  readonly id: string;
  readonly buttons: readonly AdminActionButton[];
}) {
  return (
    <span class={styles.actions}>
      {props.buttons.map((button) => (
        <form class={styles.actionForm} method="post" action={ADMIN_ACTION_ROUTE}>
          <input type="hidden" name="name" value={button.name} />
          <input type="hidden" name="id" value={props.id} />
          {button.destructive ? (
            <label class={styles.confirm}>
              {/* The echo a destructive action must carry. Typed, not pre-filled: the token is on
                  screen so it can be copied, and copying it is the deliberate act. */}
              {t('admin.actions.confirm.label', {
                token: confirmationToken(props.entity, props.id),
              })}
              <input name="confirmation" autocomplete="off" required />
            </label>
          ) : null}
          <button type="submit" class={button.destructive ? styles.destructive : styles.button}>
            {t(button.labelKey)}
          </button>
        </form>
      ))}
    </span>
  );
}

/** One generated resource screen: the table when the actor may list it, the refusal when not. */
export function ResourceView(props: { readonly screen: ResourceScreen }) {
  // Computed once: every policy in this app is `can(...)` with no predicate, so the decision does
  // not read the row — a per-row re-decision would be the same answer asked N times.
  const actionable = props.screen.buttons.length > 0;

  return (
    <section class={styles.panel}>
      {props.screen.denial === null ? (
        <table class={styles.table}>
          <thead>
            <tr>
              {props.screen.columns.map((column) => (
                <th>{t(column.labelKey)}</th>
              ))}
              {actionable ? <th>{t('admin.actions.column')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {props.screen.rows.map((row) => (
              <tr>
                {row.cells.map((value) => (
                  <td>{value}</td>
                ))}
                {actionable ? (
                  <td>
                    <RowActions
                      entity={props.screen.name}
                      id={row.id}
                      buttons={props.screen.buttons}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class={styles.refusal}>
          {t('admin.denied.body', {
            permission: props.screen.denial.permission,
            reason: props.screen.denial.reason,
          })}
        </p>
      )}
      {actionable ? null : <p class={styles.note}>{t('admin.actions.none')}</p>}
      <OperationMatrix rows={props.screen.matrix} />
    </section>
  );
}
