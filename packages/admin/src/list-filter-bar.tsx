// The filter bar: one control per derived filter, in one native GET form. Submitting it IS the
// navigation — every input is named for the URL parameter it sets (`list-filters.ts`), an empty
// one is no parameter, and the list's scope and sort ride along hidden. No script, no handler.

import { t } from '@ultimat3/i18n';
import { Button, Field, type FieldControl, Input, Link, Select } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import type { AdminField, AdminFilterKind } from './fields';
import { filterParam } from './list-filters';
import { SCOPE_PARAM, SORT_PARAM } from './list-request';
import type { AdminListRequest } from './list-scope';
import type { AdminFilter, FilterOp } from './registry';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';
import { optionLabel } from './widgets';

export interface AdminFilterBarProps {
  readonly resource: AdminResource;
  /** The list as it was asked for: what each control is prefilled from. */
  readonly request: AdminListRequest;
  readonly ctx: WidgetContext;
  /** The bare list URL — the form's `action`, and where Clear goes with the scope kept. */
  readonly action: string;
  readonly clearHref: string;
  /** This page's own URL: where a lookup screen sends the operator back with the id chosen. */
  readonly returnTo: string;
}

/** The operators a shape's CONTROLS write. Any other active filter rides the form hidden. */
const CONTROL_OPS: Readonly<Record<AdminFilterKind, readonly FilterOp[]>> = {
  text: ['contains'],
  exact: ['eq'],
  choice: ['eq'],
  boolean: ['eq'],
  range: ['gte', 'lte'],
  reference: ['eq'],
};

/** Read through a Map: an unknown shape draws no control rather than a prototype member. */
const CONTROLS: ReadonlyMap<string, readonly FilterOp[]> = new Map(Object.entries(CONTROL_OPS));

const controlOps = (field: AdminField): readonly FilterOp[] =>
  field.filterKind === undefined ? [] : (CONTROLS.get(field.filterKind) ?? []);

const written = (value: AdminFilter['value'] | undefined): readonly string[] =>
  value === undefined || value === null ? [] : typeof value === 'object' ? value : [String(value)];

const wiring = (control: FieldControl): { id: string; 'aria-describedby': string | undefined } => ({
  id: control.id,
  'aria-describedby': control['aria-describedby'],
});

export function AdminFilterBar(props: AdminFilterBarProps): JSX.Element | null {
  const { resource, request } = props;
  if (resource.filters.length === 0) return null;
  const active = request.filters ?? [];
  const current = (field: AdminField, op: FilterOp): string =>
    written(active.find((one) => one.field === field.name && one.op === op)?.value)[0] ?? '';

  const any = { value: '', label: t('admin.filter.any') };

  const control = (field: AdminField, own: FieldControl): JSX.Element => {
    const name = filterParam(field, controlOps(field)[0] ?? 'eq');
    const value = current(field, controlOps(field)[0] ?? 'eq');
    switch (field.filterKind) {
      case 'boolean':
        return (
          <Select
            {...wiring(own)}
            name={name}
            value={value}
            options={[
              any,
              { value: 'true', label: t('admin.value.true') },
              { value: 'false', label: t('admin.value.false') },
            ]}
          />
        );
      case 'choice':
        return field.values === undefined ? (
          <Input {...wiring(own)} name={name} value={value} />
        ) : (
          <Select
            {...wiring(own)}
            name={name}
            value={value}
            // The entity's own values, labelled by the catalog where it has them: no option list
            // is written in the app.
            options={[
              any,
              ...field.values.map((one) => ({ value: one, label: optionLabel(field, one) })),
            ]}
          />
        );
      case 'range': {
        const type =
          field.type === 'date' ? 'date' : field.type === 'timestamptz' ? 'datetime-local' : 'text';
        // `datetime-local` shows minutes; the stored filter is the ISO instant it was parsed to.
        const shown = (op: FilterOp): string =>
          field.type === 'timestamptz' ? current(field, op).slice(0, 16) : current(field, op);
        return (
          <span class={styles['range']}>
            <Input
              {...wiring(own)}
              name={filterParam(field, 'gte')}
              type={type}
              inputmode={field.type === 'number' ? 'decimal' : undefined}
              aria-label={t('admin.filter.from', { field: t(field.labelKey) })}
              value={shown('gte')}
            />
            <Input
              name={filterParam(field, 'lte')}
              type={type}
              inputmode={field.type === 'number' ? 'decimal' : undefined}
              aria-label={t('admin.filter.to', { field: t(field.labelKey) })}
              // An instant is typed in UTC and says so beside the box, as the edit form does.
              suffix={field.type === 'timestamptz' ? 'UTC' : undefined}
              value={shown('lte')}
            />
          </span>
        );
      }
      case 'reference': {
        const entity = field.relation?.entity ?? '';
        const options = props.ctx.optionsFor?.(entity) ?? null;
        if (options !== null) {
          return (
            <Select
              {...wiring(own)}
              name={name}
              value={value}
              options={[any, ...options.map((one) => ({ value: one.id, label: one.label }))]}
            />
          );
        }
        // Too many rows for a select: the id is typed, or found on the target's lookup screen,
        // which links back here with this parameter set.
        const lookup = props.ctx.lookupHref?.(entity) ?? null;
        const find =
          lookup === null
            ? null
            : `${lookup}?${new URLSearchParams({ return: props.returnTo, as: name }).toString()}`;
        return (
          <span class={styles['range']}>
            <Input {...wiring(own)} name={name} value={value} />
            {find === null ? null : <a href={find}>{t('admin.filter.find')}</a>}
          </span>
        );
      }
      default:
        return (
          <Input
            {...wiring(own)}
            name={name}
            type={field.filterKind === 'text' ? 'search' : 'text'}
            value={value}
          />
        );
    }
  };

  // A filter the URL carries that no control above writes (`f.status.in`, `f.stock.gt`): kept, so
  // submitting the form narrows the list the operator is looking at instead of widening it.
  const carried = active.filter((one) => {
    const field = resource.filters.find((known) => known.name === one.field);
    return field !== undefined && !controlOps(field).includes(one.op);
  });

  return (
    <search>
      <form class={styles['filters']} method="get" action={props.action}>
        {request.scope === undefined || request.scope === null ? null : (
          <input type="hidden" name={SCOPE_PARAM} value={request.scope} />
        )}
        {request.sort === undefined ? null : (
          <input
            type="hidden"
            name={SORT_PARAM}
            value={`${request.sort.field}:${request.sort.direction}`}
          />
        )}
        {carried.flatMap((one) => {
          const field = resource.filters.find((known) => known.name === one.field);
          return field === undefined
            ? []
            : written(one.value).map((value) => (
                <input type="hidden" name={filterParam(field, one.op)} value={value} />
              ));
        })}
        {resource.filters.map((field) => (
          <Field label={t(field.labelKey)}>{(own) => control(field, own)}</Field>
        ))}
        <div class={styles['actions']}>
          <Button type="submit" variant="secondary">
            {t('admin.filter.apply')}
          </Button>
          {active.length === 0 ? null : (
            <Link appearance="button" variant="ghost" tone="neutral" href={props.clearHref}>
              {t('admin.filter.clear')}
            </Link>
          )}
        </div>
      </form>
    </search>
  );
}
