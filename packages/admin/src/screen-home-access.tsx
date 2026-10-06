// The `/admin` home's "Access" half: per resource the actor may open, the decision behind every
// operation it offers — the same decision the call obeys. Data-second on the page, so each matrix is
// a native `<details>`, closed, its summary the resource and how many of its operations are allowed.

import { t } from '@ultimat3/i18n';
import { Badge } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import type { CrudCtx } from './crud';
import { decideOperation, permissionsForOperation } from './crud';
import { ADMIN_OPERATIONS, type AdminOperation } from './permissions';
import type { AdminResource } from './resource';
import homeStyles from './screen-home.module.scss';

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

export interface HomeAccessProps {
  readonly basePath: string;
  readonly entries: readonly {
    readonly resource: AdminResource;
    readonly rows: readonly OperationDecision[];
  }[];
}

/**
 * Every matrix is in the document — closed is a presentation, never a withheld fact — and the
 * summary's badge says at a glance whether the actor holds the whole resource or only part of it.
 */
export function HomeAccess(props: HomeAccessProps): JSX.Element {
  return (
    <section class={homeStyles['access']} aria-labelledby="admin-home-access">
      <h2 id="admin-home-access" class={homeStyles['heading']}>
        {t('admin.dashboard.access.title')}
      </h2>
      {props.entries.map(({ resource, rows }) => {
        const allowed = rows.filter((row) => row.allowed).length;
        return (
          <details class={homeStyles['resource']}>
            <summary class={homeStyles['summary']}>
              <span class={homeStyles['name']}>{t(resource.titleKey)}</span>
              <Badge tone={allowed === rows.length ? 'success' : 'neutral'} size="sm">
                {t('admin.dashboard.access.allowed', { allowed, total: rows.length })}
              </Badge>
            </summary>
            <div class={homeStyles['body']}>
              <a href={`${props.basePath}${resource.path}`}>{t('admin.dashboard.access.open')}</a>
              <div class={homeStyles['matrixScroll']}>
                <OperationMatrix rows={rows} />
              </div>
            </div>
          </details>
        );
      })}
    </section>
  );
}
