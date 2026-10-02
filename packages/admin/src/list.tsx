// The list view: scope tabs, the filter bar, the batch bar, derived and computed columns, keyset
// pagination, and the states a server-rendered table has (rows, empty, error). Every control is a
// link or a native form — a row opens through a real `<a href>`, a header sorts through one,
// paging is `<Pagination hrefFor>`, a row is selected by a checkbox the batch form owns — so the
// page ships no script and there is nothing to hydrate.
// Prev/Next are the only navigation: there is no page number, because there is no offset.

import { t } from '@ultimat3/i18n';
import { Card, DataTable, ErrorState } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { decideAction } from './action-gate';
import { AdminActions } from './actions';
import type { AdminActor, AdminAuthz } from './authz';
import { AdminBatchBar, BatchCheckbox } from './batch-bar';
import { type AdminErrorParts, adminErrorFrom } from './errors';
import { resourceColumns } from './list-columns';
import { AdminFilterBar } from './list-filter-bar';
import type { ListLocation } from './list-request';
import type { AdminListRequest } from './list-scope';
import { AdminScopeTabs } from './list-scope-tabs';
import type { AdminPage } from './pagination';
import type { AdminRow } from './registry';
import { rowId } from './registry';
import type { AdminResource } from './resource';
import type { AdminScope } from './resource-list';
import type { WidgetContext } from './widget-value';

export interface AdminListProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly page: AdminPage<Row>;
  readonly error: AdminErrorParts | null;
  readonly ctx: WidgetContext;
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly basePath: string;
  /** The list as it was asked for — its scope, filters and sort ride every link on the page. */
  readonly request: AdminListRequest;
  /** The scope the page was READ under: the request's, or the resource's default. */
  readonly scope: AdminScope | null;
  /** The count of each scope that declared `count: true`, and of no other. */
  readonly counts: ReadonlyMap<string, number>;
  /** The URL of one list state — `listHref()`, bound to this admin and this resource. */
  readonly hrefFor: (location: ListLocation) => string;
}

export function AdminList<Row extends AdminRow>(props: AdminListProps<Row>): JSX.Element {
  const href = (id: string): string => `${props.basePath}${props.resource.path}/${id}`;
  const idOf = (row: Row): string => rowId(row, props.resource.idField);

  if (props.error !== null) {
    return <ErrorState error={adminErrorFrom(props.error)} />;
  }

  const page = props.page;
  // The base `AdminResource`: this component's own `Row` is the app's, the pieces below read rows
  // as `AdminRow`, and a resource is the same object either way.
  const resource: AdminResource = props.resource as unknown as AdminResource;
  const acts = resource.actions.length > 0;
  const sealed = resource.secretFields.map((field) => field.name);
  // The batch actions THIS actor may run — the gate's own answer, asked once for the list. A row
  // the action's `when` excludes is still selectable: the server counts it `refused`, by name.
  const batch = resource.actions.filter(
    (action) =>
      action.batch !== undefined &&
      decideAction(action, props.actor, props.authz, { entity: resource.name }).allowed,
  );
  const { scope, filters, sort } = props.request;
  /** Everything but the cursor: a cursor is a position IN this state, never part of it. */
  const state: ListLocation = {
    ...(scope === undefined ? {} : { scope }),
    ...(filters === undefined ? {} : { filters }),
    ...(sort === undefined ? {} : { sort }),
  };

  return (
    <Card header={<h2>{t(resource.titleKey)}</h2>}>
      <AdminScopeTabs
        resource={resource}
        active={props.scope}
        counts={props.counts}
        locale={props.ctx.locale}
        hrefFor={(name) => props.hrefFor({ ...state, scope: name })}
      />
      <AdminFilterBar
        resource={resource}
        request={props.request}
        ctx={props.ctx}
        action={props.hrefFor({})}
        clearHref={props.hrefFor({
          ...(scope === undefined ? {} : { scope }),
          ...(sort === undefined ? {} : { sort }),
        })}
        returnTo={props.hrefFor(state)}
      />
      <AdminBatchBar actions={batch} href={props.hrefFor(state)} />
      {page.rows.length === 0 ? (
        <p class="x-admin-empty">{t('admin.list.empty')}</p>
      ) : (
        <DataTable
          caption={t(resource.titleKey)}
          columns={[
            ...(batch.length === 0
              ? []
              : [
                  {
                    key: 'select',
                    header: t('admin.batch.select'),
                    cell: (row: Row) => (
                      <BatchCheckbox
                        id={idOf(row)}
                        label={t('admin.batch.select-row', { id: idOf(row) })}
                      />
                    ),
                  },
                ]),
            // The resource's columns, the same ones a related card on another detail page draws.
            ...resourceColumns({ resource, ctx: props.ctx, hrefOf: href }),
            // Decided per ROW, with the row on the subject: a rule that reads it (ownership, a
            // state) answers for this row and not for the table.
            ...(acts
              ? [
                  {
                    key: 'actions',
                    header: t('admin.actions.label'),
                    cell: (row: Row) => (
                      <AdminActions
                        actions={resource.actions}
                        actor={props.actor}
                        authz={props.authz}
                        subject={{ entity: resource.name, id: idOf(row), row }}
                        sealed={sealed}
                        href={href(idOf(row))}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          rows={page.rows}
          rowKey={idOf}
          sort={{ key: page.sort.field, direction: page.sort.direction }}
          nextCursor={page.hasMore ? (page.nextCursor ?? undefined) : undefined}
          prevCursor={page.prevCursor ?? undefined}
          hrefFor={(cursor) => props.hrefFor({ ...state, cursor })}
          // The header's NEXT state, as a URL. "Unsorted" is the list with no sort in it — the
          // resource's own default order.
          sortHrefFor={(next) => {
            const { sort: _current, ...rest } = state;
            return props.hrefFor(
              next === undefined
                ? rest
                : { ...rest, sort: { field: next.key, direction: next.direction } },
            );
          }}
        />
      )}
    </Card>
  );
}
