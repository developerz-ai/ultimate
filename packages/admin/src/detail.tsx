// The detail view: the row's fields in their sections, the related resources' own lists filtered
// to this row, the row's history, and the actions this actor may run on it — each a link or a
// native form, so the screen ships no script. A detail page with no row is a state, not a card.

import { t } from '@ultimat3/i18n';
import { Button, Card, DataTable, ErrorState, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { AdminActions, ConfirmationField, DELETE_OPERATION, OPERATION_FIELD } from './actions';
import styles from './admin.module.scss';
import type { AuditCursor, AuditEntry } from './audit';
import type { AdminActor, AdminAuthz } from './authz';
import { type AdminErrorParts, adminErrorFrom } from './errors';
import { valueText } from './json-text';
import { resourceColumns } from './list-columns';
import { confirmationToken } from './permissions';
import type { AdminRow } from './registry';
import { rowId } from './registry';
import type { AdminRelatedList } from './related';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminDetailProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly row: Row | null;
  readonly error: AdminErrorParts | null;
  readonly ctx: WidgetContext;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  /** This row's history, newest first: one keyset page of what changed it or was refused. */
  readonly audit: readonly AuditEntry[];
  /** The URL of the next, older page of the history, or `null` when this page is the last. */
  readonly olderHref?: string | null;
  /** Each declared related resource's own list, filtered to this row. */
  readonly related?: readonly AdminRelatedList[];
  /** The URL of a related resource's list, filtered to this row — "everything", one link away. */
  readonly relatedHref?: (list: AdminRelatedList) => string;
  readonly basePath: string;
  /**
   * What the gate already decided about THIS row, so the view renders a control only for an
   * operation the POST behind it would allow. Absent reads as "not allowed".
   */
  readonly may?: { readonly update: boolean; readonly delete: boolean };
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
  const href = `${props.basePath}${props.resource.path}/${id}`;

  return (
    <>
      <Card header={<h2>{t(props.resource.titleKey)}</h2>}>
        <AdminActions
          actions={props.resource.actions}
          actor={props.actor}
          authz={props.authz}
          subject={{ entity: props.resource.name, id, row }}
          sealed={props.resource.secretFields.map((field) => field.name)}
          href={href}
        />

        {props.resource.sections.map((section) => (
          <section class={styles['section']}>
            {section.titleKey === null ? null : <h3>{t(section.titleKey)}</h3>}
            <dl class={styles['fields']}>
              {section.fields.map((field) => (
                <>
                  <dt>{t(field.labelKey)}</dt>
                  <dd>
                    <Widget field={field} value={row[field.name]} ctx={props.ctx} mode="read" />
                  </dd>
                </>
              ))}
            </dl>
          </section>
        ))}

        <div class={styles['actions']}>
          {props.may?.update === true ? (
            <Link appearance="button" variant="secondary" tone="neutral" href={`${href}/edit`}>
              {t('admin.detail.edit')}
            </Link>
          ) : null}
          {props.may?.delete === true ? (
            // Destructive, so it re-confirms: the token is on screen to be copied, and typing it
            // is the deliberate act. A native POST — the row's own URL is the subject.
            <form class={styles['actionForm']} method="post" action={href}>
              <input type="hidden" name={OPERATION_FIELD} value={DELETE_OPERATION} />
              <ConfirmationField token={confirmationToken(props.resource.name, id)} />
              <Button type="submit" size="sm" variant="secondary" tone="danger">
                {t('admin.detail.delete')}
              </Button>
            </form>
          ) : null}
        </div>
      </Card>

      {(props.related ?? []).map((list) => {
        const target = list.related.resource;
        const base = `${props.basePath}${target.path}`;
        return (
          <Card header={<h2>{t(target.titleKey)}</h2>}>
            {list.page.rows.length === 0 ? (
              <p class="x-admin-empty">{t('admin.list.empty')}</p>
            ) : (
              <DataTable
                caption={t(target.titleKey)}
                // The related resource's OWN columns, minus the key every row here shares.
                columns={resourceColumns({
                  resource: target,
                  ctx: props.ctx,
                  hrefOf: (rowKey) => `${base}/${rowKey}`,
                  omit: list.related.field,
                })}
                rows={list.page.rows}
                rowKey={(one) => rowId(one, target.idField)}
                hrefFor={() => props.relatedHref?.(list) ?? base}
              />
            )}
            {list.page.hasMore && props.relatedHref !== undefined ? (
              <Link href={props.relatedHref(list)}>{t('admin.related.all')}</Link>
            ) : null}
          </Card>
        );
      })}

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
                      <code>{change.field}</code>: <del>{valueText(change.before)}</del>{' '}
                      <ins>{valueText(change.after)}</ins>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {props.olderHref === null || props.olderHref === undefined ? null : (
          <Link href={props.olderHref}>{t('admin.audit.older')}</Link>
        )}
      </Card>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query parameter an older page of a row's history is asked for by: `?history=<at>~<id>`. */
export const HISTORY_PARAM = 'history';

/** The cursor as one parameter value — an ISO instant holds no `~`, a uuid neither. */
export const historyCursorText = (cursor: AuditCursor): string => `${cursor.at}~${cursor.id}`;

/** A posted-back cursor, or `undefined` for anything that is not one: page one, never an error. */
export function historyCursorOf(raw: string | null): AuditCursor | undefined {
  if (raw === null) return undefined;
  const at = raw.indexOf('~');
  if (at <= 0) return undefined;
  const instant = raw.slice(0, at);
  const id = raw.slice(at + 1);
  // A uuid, because the durable log compares it as one: anything else would be a cast error from
  // the database where a hand-edited URL deserves page one.
  return Number.isNaN(Date.parse(instant)) || !UUID.test(id) ? undefined : { at: instant, id };
}
