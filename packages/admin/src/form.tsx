// Create/edit form. Fields, labels, and required flags come from the resource; validation
// comes from the entity's own schema, so the form rejects exactly what the action would
// reject. Issues render against the field they name, and the summary is focusable.

import { t } from '@ultimat3/i18n';
import { Card, ErrorState, Field } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import type { ValidationIssue } from './validate';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

export interface AdminFormProps<Row extends AdminRow> {
  readonly resource: AdminResource<Row>;
  readonly mode: 'create' | 'edit';
  /** Current values, controlled by the route. Empty object for create. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly issues: readonly ValidationIssue[];
  readonly submitting: boolean;
  readonly error: { readonly code: string; readonly cause: string; readonly fix: string } | null;
  readonly ctx: WidgetContext;
  readonly onInput: (field: string, value: unknown) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

const issuesFor = (issues: readonly ValidationIssue[], field: string): readonly ValidationIssue[] =>
  issues.filter((issue) => issue.path === field);

export function AdminForm<Row extends AdminRow>(props: AdminFormProps<Row>): JSX.Element {
  if (props.error !== null) {
    return <ErrorState code={props.error.code} cause={props.error.cause} fix={props.error.fix} />;
  }

  const titleKey = props.mode === 'create' ? 'admin.form.create' : 'admin.form.edit';

  return (
    <Card title={t(titleKey, { entity: t(props.resource.titleKey) })}>
      <form
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        {props.issues.length === 0 ? null : (
          <div class="x-admin-issues" role="alert" tabindex={-1}>
            <h3>{t('admin.form.issues')}</h3>
            <ul>
              {props.issues.map((issue) => (
                <li>
                  <a href={`#x-admin-field-${issue.path}`}>{issue.path}</a>: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {props.resource.formFields.map((field) => {
          const own = issuesFor(props.issues, field.name);
          return (
            <Field
              label={t(field.labelKey)}
              name={field.name}
              required={field.required}
              invalid={own.length > 0}
              id={`x-admin-field-${field.name}`}
            >
              <Widget
                field={field}
                value={props.values[field.name]}
                ctx={props.ctx}
                mode="edit"
                onInput={props.onInput}
              />
              {own.map((issue) => (
                <p class="x-admin-issue">{issue.message}</p>
              ))}
            </Field>
          );
        })}

        <div class="x-admin-form-actions">
          <button type="submit" disabled={props.submitting}>
            {t(props.submitting ? 'admin.form.saving' : 'admin.form.save')}
          </button>
          <button type="button" onClick={() => props.onCancel()}>
            {t('admin.form.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}
