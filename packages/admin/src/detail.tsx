// The detail view: every field as a labelled read-only row, the audit trail for this row,
// and the actions this actor may run on it. Loading and error states are first-class, not an
// afterthought — a detail page with no row is a state, not a blank card.

import { t } from '@ultimat3/i18n';
import { Card, ErrorState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminActionButton } from './action-gate';
import { AdminActions } from './actions';
import type { AuditEntry } from './audit';
import type { AdminActor, AdminAuthz } from './authz';
import { type AdminErrorParts, adminErrorFrom } from './errors';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminDetailProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly row: Row | null;
  readonly loading: boolean;
  readonly error: AdminErrorParts | null;
  readonly ctx: WidgetContext;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly audit: readonly AuditEntry[];
  readonly basePath: string;
  readonly pending?: AdminActionButton | null;
  readonly confirmation?: string;
  readonly onRun?: (button: AdminActionButton, confirmation: string) => void;
  readonly onRequestConfirm?: (button: AdminActionButton) => void;
  readonly onConfirmationInput?: (value: string) => void;
  readonly onCancel?: () => void;
}

/**
 * The audit row's verb. `operation` holds a CRUD verb for `kind: 'operation'` and the ACTION NAME
 * for `kind: 'action'`, and the catalog declares only `admin.operation.{list,detail,search,create,
 * update,delete,page}` — so an entry for `post.publish` rendered the literal key
 * `admin.operation.post.publish` into the page. `admin.action.<name>` is the same key
 * `action-gate.ts` gives the button that ran it, so the two read identically.
 */
export const operationLabel = (entry: AuditEntry): string =>
  entry.kind === 'action'
    ? t(`admin.action.${entry.operation}`)
    : t(`admin.operation.${entry.operation}`);

export function AdminDetail<Row extends AdminRow>(props: AdminDetailProps<Row>): JSX.Element {
  if (props.error !== null) {
    return <ErrorState error={adminErrorFrom(props.error)} />;
  }
  if (props.loading) {
    return (
      <Card header={<h2>{t(props.resource.titleKey)}</h2>}>
        <p aria-busy="true">{t('admin.detail.loading')}</p>
      </Card>
    );
  }
  if (props.row === null) {
    return (
      <ErrorState
        error={adminErrorFrom({
          code: 'X_ADMIN_ENTITY_UNKNOWN',
          // `.cause`, not a bare `admin.detail.not-found`: a catalog is authored nested and
          // `parseNestedCatalog` refuses a dot inside a key, so a name is a leaf or a branch and
          // never both — `admin.detail.not-found` + `.fix` could not have coexisted in en.json.
          cause: t('admin.detail.not-found.cause', { entity: props.resource.name }),
          fix: t('admin.detail.not-found.fix'),
        })}
      />
    );
  }

  const row = props.row;
  const id = String(row[props.resource.idField] ?? '');

  return (
    <>
      <Card header={<h2>{t(props.resource.titleKey)}</h2>}>
        <AdminActions
          actions={props.resource.actions}
          actor={props.actor}
          authz={props.authz}
          subject={{ entity: props.resource.name, id }}
          pending={props.pending ?? null}
          confirmation={props.confirmation ?? ''}
          onRun={props.onRun}
          onRequestConfirm={props.onRequestConfirm}
          onConfirmationInput={props.onConfirmationInput}
          onCancel={props.onCancel}
        />

        <dl class="x-admin-detail">
          {props.resource.fields
            .filter((field) => !field.sensitive)
            .map((field) => (
              <>
                <dt>{t(field.labelKey)}</dt>
                <dd>
                  <Widget field={field} value={row[field.name]} ctx={props.ctx} mode="read" />
                </dd>
              </>
            ))}
        </dl>

        <a href={`${props.basePath}${props.resource.path}/${id}/edit`}>{t('admin.detail.edit')}</a>
      </Card>

      <Card header={<h2>{t('admin.audit.title')}</h2>}>
        {props.audit.length === 0 ? (
          <p class="x-admin-empty">{t('admin.audit.empty')}</p>
        ) : (
          <ol class="x-admin-audit">
            {props.audit.map((entry) => (
              <li>
                <code>{entry.at}</code> <span>{entry.actor.id}</span>{' '}
                <span>{operationLabel(entry)}</span>{' '}
                <span data-outcome={entry.outcome}>
                  {t(`admin.audit.outcome.${entry.outcome}`)}
                </span>
                <ul>
                  {entry.diff.map((change) => (
                    <li>
                      <code>{change.field}</code>: <del>{String(change.before ?? '')}</del>{' '}
                      <ins>{String(change.after ?? '')}</ins>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
