// Create/edit form, as a native `<form method="post">`. Fields, labels, hints, groups and required
// flags come from the resource; validation comes from the entity's own schema, so the form rejects
// exactly what the action would reject. A refused submit re-renders this with the posted values and the
// issues against the fields they name — there is no client state to lose.

import { t } from '@ultimat3/i18n';
import { Button, Card, ErrorState, Field, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import { type AdminErrorParts, adminErrorFrom } from './errors';
import type { AdminField } from './fields';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import { fieldsFor } from './resource-layout';
import type { ValidationIssue } from './validate';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminFormProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly mode: 'create' | 'edit';
  /** The stored row on a first render, the posted values on a refused one. Empty for create. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly issues: readonly ValidationIssue[];
  readonly error: AdminErrorParts | null;
  readonly ctx: WidgetContext;
  /** Where the form posts: the URL that rendered it. */
  readonly action: string;
  /** Where Cancel goes — the list for a create, the row for an edit. */
  readonly cancelHref: string;
}

const issuesFor = (issues: readonly ValidationIssue[], field: string): readonly ValidationIssue[] =>
  issues.filter((issue) => issue.path === field);

/**
 * The line under a control: the declared `hintKey`, and — for a sealed column on an edit — that an
 * empty box keeps the stored value. Both, when both apply.
 */
const hintOf = (field: AdminField, unchanged: boolean): string | undefined => {
  const lines = [
    ...(field.hintKey === undefined ? [] : [t(field.hintKey)]),
    ...(unchanged ? [t('admin.form.secret-unchanged')] : []),
  ];
  return lines.length === 0 ? undefined : lines.join(' ');
};

/** An issue the admin raised itself carries a key; the schema's own carry their message. */
export const issueText = (issue: ValidationIssue): string =>
  issue.messageKey === undefined ? issue.message : t(issue.messageKey);

export function AdminForm<Row extends AdminRow>(props: AdminFormProps<Row>): JSX.Element {
  if (props.error !== null) {
    return <ErrorState error={adminErrorFrom(props.error)} />;
  }

  const titleKey = props.mode === 'create' ? 'admin.form.create' : 'admin.form.edit';

  const input = (field: AdminField): JSX.Element => {
    const secret = field.type === 'secret';
    const own = issuesFor(props.issues, field.name);
    return (
      // The anchor target the issue summary links to. <Field> owns the control's own
      // id, so the deep link lands on the wrapper and the label still points at the input.
      <div id={`x-admin-field-${field.name}`}>
        <Field
          label={t(field.labelKey)}
          // A sealed column is required to CREATE a row and optional ever after: an empty box on
          // an edit means "leave it as it is", because nothing can prefill it.
          required={secret ? field.required && props.mode === 'create' : field.required}
          hint={hintOf(field, secret && props.mode === 'edit')}
          error={own.length === 0 ? undefined : own.map(issueText).join(' ')}
        >
          {(control) => (
            <Widget
              field={field}
              // A sealed column's widget takes no value by TYPE (`widget-value.ts`), so what a
              // refused post typed into it is dropped there, once, for every caller.
              value={props.values[field.name]}
              ctx={props.ctx}
              mode="edit"
              control={control}
            />
          )}
        </Field>
      </div>
    );
  };

  return (
    <Card header={<h2>{t(titleKey, { entity: t(props.resource.titleKey) })}</h2>}>
      <form class={styles['form']} method="post" action={props.action}>
        {props.issues.length === 0 ? null : (
          <div class="x-admin-issues" role="alert" tabindex={-1}>
            <h3>{t('admin.form.issues')}</h3>
            <ul>
              {props.issues.map((issue) => (
                <li>
                  <a href={`#x-admin-field-${issue.path}`}>{issue.path}</a>: {issueText(issue)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {props.resource.formGroups.map((group) => {
          // A field that exists on the other side only (`on`) is not drawn, and a group left
          // with nothing to draw is not drawn either.
          const fields = fieldsFor(group.fields, props.mode);
          if (fields.length === 0) return null;
          return group.titleKey === null ? (
            fields.map(input)
          ) : (
            <fieldset class={styles['section']}>
              <legend>{t(group.titleKey)}</legend>
              {fields.map(input)}
            </fieldset>
          );
        })}

        <div class={styles['actions']}>
          <Button type="submit">{t('admin.form.save')}</Button>
          <Link appearance="button" variant="ghost" tone="neutral" href={props.cancelHref}>
            {t('admin.form.cancel')}
          </Link>
        </div>
      </form>
    </Card>
  );
}
