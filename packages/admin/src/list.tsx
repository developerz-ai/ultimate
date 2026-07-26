// The list view: derived columns, keyset pagination, and the three states a table actually
// has (loading, empty, error) instead of the one it usually ships with. Prev/Next are the
// only navigation — there is no page number, because there is no offset.

import { t } from '@ultimat3/i18n';
import { Card, DataTable, ErrorState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { AdminActions } from './actions';
import type { AdminActor, AdminAuthz } from './authz';
import type { AdminPage } from './pagination';
import type { AdminRow } from './registry';
import { rowId } from './registry';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminListProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly page: AdminPage<Row> | null;
  readonly loading: boolean;
  readonly error: { readonly code: string; readonly cause: string; readonly fix: string } | null;
  readonly ctx: WidgetContext;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly basePath: string;
  readonly onCursor: (cursor: string | null) => void;
  readonly onOpen: (id: string) => void;
}

export function AdminList<Row extends AdminRow>(props: AdminListProps<Row>): JSX.Element {
  const href = (id: string): string => `${props.basePath}${props.resource.path}/${id}`;

  if (props.error !== null) {
    return <ErrorState code={props.error.code} cause={props.error.cause} fix={props.error.fix} />;
  }

  if (props.loading || props.page === null) {
    return (
      <Card title={t(props.resource.titleKey)}>
        <p aria-busy="true">{t('admin.list.loading')}</p>
      </Card>
    );
  }

  const page = props.page;

  return (
    <Card title={t(props.resource.titleKey)}>
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
          columns={props.resource.listFields.map((field) => ({
            key: field.name,
            header: t(field.labelKey),
            sortable: field.sortable,
          }))}
          rows={page.rows.map((row) => ({
            id: rowId(row, props.resource.idField),
            href: href(rowId(row, props.resource.idField)),
            cells: props.resource.listFields.map((field) => (
              <Widget field={field} value={row[field.name]} ctx={props.ctx} mode="read" />
            )),
          }))}
          sort={page.sort}
          onActivate={(id: string) => props.onOpen(id)}
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
