// The list view: derived columns, keyset pagination, and the three states a table actually
// has (loading, empty, error) instead of the one it usually ships with. Prev/Next are the
// only navigation — there is no page number, because there is no offset.

import { t } from '@ultimat3/i18n';
import { Card, DataTable, ErrorState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { AdminActions } from './actions';
import type { AdminActor, AdminAuthz } from './authz';
import { type AdminErrorParts, adminErrorFrom } from './errors';
import type { AdminPage } from './pagination';
import type { AdminRow, AdminSort } from './registry';
import { rowId } from './registry';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminListProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly page: AdminPage<Row> | null;
  readonly loading: boolean;
  readonly error: AdminErrorParts | null;
  readonly ctx: WidgetContext;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly basePath: string;
  readonly onCursor: (cursor: string | null) => void;
  readonly onOpen: (id: string) => void;
  /** Absent means the table renders its current order without sortable headers. */
  readonly onSort?: (sort: AdminSort) => void;
}

export function AdminList<Row extends AdminRow>(props: AdminListProps<Row>): JSX.Element {
  const href = (id: string): string => `${props.basePath}${props.resource.path}/${id}`;
  const idOf = (row: Row): string => rowId(row, props.resource.idField);

  if (props.error !== null) {
    return <ErrorState error={adminErrorFrom(props.error)} />;
  }

  if (props.loading || props.page === null) {
    return (
      <Card header={<h2>{t(props.resource.titleKey)}</h2>}>
        <p aria-busy="true">{t('admin.list.loading')}</p>
      </Card>
    );
  }

  const page = props.page;

  return (
    <Card header={<h2>{t(props.resource.titleKey)}</h2>}>
      <AdminActions
        actions={props.resource.actions}
        actor={props.actor}
        authz={props.authz}
        subject={{ entity: props.resource.name }}
        onRun={() => props.onCursor(null)}
      />

      {page.rows.length === 0 ? (
        <p class="x-admin-empty">{t('admin.list.empty')}</p>
      ) : (
        <DataTable
          caption={t(props.resource.titleKey)}
          columns={[
            // A real link, not a row click handler: the detail view has to survive a
            // middle-click, a keyboard, and a crawler that never runs the onClick.
            {
              key: 'open',
              header: t('admin.list.open'),
              cell: (row: Row) => (
                <a
                  href={href(idOf(row))}
                  onClick={(event) => {
                    event.preventDefault();
                    props.onOpen(idOf(row));
                  }}
                >
                  {idOf(row)}
                </a>
              ),
            },
            ...props.resource.listFields.map((field) => ({
              key: field.name,
              header: t(field.labelKey),
              sortable: field.sortable && props.onSort !== undefined,
              cell: (row: Row) => (
                <Widget field={field} value={row[field.name]} ctx={props.ctx} mode="read" />
              ),
            })),
          ]}
          rows={page.rows}
          rowKey={idOf}
          sort={{ key: page.sort.field, direction: page.sort.direction }}
          onSortChange={(next) => {
            if (next !== undefined) props.onSort?.({ field: next.key, direction: next.direction });
          }}
        />
      )}

      <nav class="x-admin-pager" aria-label={t('admin.list.pagination')}>
        <button
          type="button"
          disabled={page.prevCursor === null}
          onClick={() => props.onCursor(page.prevCursor)}
        >
          {t('admin.list.previous')}
        </button>
        <button
          type="button"
          disabled={!page.hasMore}
          onClick={() => props.onCursor(page.nextCursor)}
        >
          {t('admin.list.next')}
        </button>
      </nav>
    </Card>
  );
}
