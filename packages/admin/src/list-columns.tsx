// The columns a resource's table has, wherever it is drawn: its own list page, and the related
// card on another resource's detail page. One definition — the link that opens the row, the
// derived list fields, the computed columns — so a related list IS the resource's list and never
// a second table somebody declared beside it.

import { t } from '@ultimat3/i18n';
import type { Column } from '@ultimat3/ui';
import { type AdminRow, computedRow, rowId } from './registry';
import { ComputedCell } from './renderers';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface ResourceColumnsInput {
  readonly resource: AdminResource;
  readonly ctx: WidgetContext;
  /** The URL of one row's detail page. */
  readonly hrefOf: (id: string) => string;
  /** A list field to leave out — the foreign key a related card is already filtered by. */
  readonly omit?: string;
}

export function resourceColumns(input: ResourceColumnsInput): readonly Column<AdminRow>[] {
  const { resource, ctx } = input;
  const idOf = (row: AdminRow): string => rowId(row, resource.idField);
  const sealed = resource.secretFields.map((field) => field.name);
  return [
    // A real link, not a row click handler: the detail view has to survive a middle-click, a
    // keyboard, and a crawler that never runs an onClick.
    {
      key: 'open',
      header: t('admin.list.open'),
      cell: (row) => <a href={input.hrefOf(idOf(row))}>{idOf(row)}</a>,
    },
    ...resource.listFields
      .filter((field) => field.name !== input.omit)
      .map((field) => ({
        key: field.name,
        header: t(field.labelKey),
        sortable: field.sortable,
        cell: (row: AdminRow) => (
          <Widget field={field} value={row[field.name]} ctx={ctx} mode="read" />
        ),
      })),
    ...resource.columns.map((column) => ({
      key: column.name,
      header: t(column.labelKey),
      cell: (row: AdminRow) => (
        <ComputedCell column={column} row={computedRow(row, sealed)} ctx={ctx} />
      ),
    })),
  ];
}
