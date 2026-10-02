// An action's own form: one control per property of its input schema, the confirmation a
// destructive one needs, and the issues its schema raised against the fields that carried them.
// A native `<form method="post">` at the row's URL (or the list's, for a batch) — the page ships
// no script, so the round trip to the server IS the confirmation dialog.

import { t } from '@ultimat3/i18n';
import { Button, Card, Checkbox, Field, Input, Link, Select, Textarea } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { ACTION_INPUT_PREFIX, type ActionInputField, actionInputFields } from './action-input';
import { actionLabelKey } from './action-label';
import { ConfirmationField, OPERATION_FIELD } from './actions';
import styles from './admin.module.scss';
import { issueText } from './form';
import type { AdminAction } from './registry';
import type { ValidationIssue } from './validate';

export interface AdminActionFormProps {
  readonly action: AdminAction;
  /** Where the form posts: the row's URL, or the list's for a batch. */
  readonly href: string;
  /** `ACTION_OPERATION` for one row, `BATCH_OPERATION` for a selection. */
  readonly operation: string;
  /** What was typed, on a refused post. Empty on the first render. */
  readonly values: Readonly<Record<string, string>>;
  readonly issues: readonly ValidationIssue[];
  /** The token a destructive action makes the operator type. `null`: not destructive. */
  readonly confirmation: string | null;
  /** One line above the fields saying what the action will run on — a row, or a count. */
  readonly subject: string;
  /** Posted back untouched: the selection of a batch, its filter position. */
  readonly hidden?: readonly (readonly [name: string, value: string])[];
  readonly cancelHref: string;
}

function control(
  field: ActionInputField,
  value: string | undefined,
  shared: { readonly id: string; readonly 'aria-describedby': string | undefined },
): JSX.Element {
  const name = `${ACTION_INPUT_PREFIX}${field.name}`;
  switch (field.control) {
    case 'checkbox':
      return (
        <Checkbox
          {...shared}
          name={name}
          label={t(field.labelKey)}
          checked={value !== undefined && value !== 'false'}
        />
      );
    case 'select':
      return (
        <Select
          {...shared}
          name={name}
          value={value ?? ''}
          options={[
            ...(field.required ? [] : [{ value: '', label: t('admin.value.empty') }]),
            ...field.values.map((one) => ({ value: one, label: one })),
          ]}
        />
      );
    case 'json':
      return <Textarea {...shared} class="x-admin-json" name={name} value={value ?? ''} />;
    case 'datetime':
      // The stored value is a UTC instant, so the control edits UTC and says so beside the box.
      return (
        <Input {...shared} name={name} type="datetime-local" value={value ?? ''} suffix="UTC" />
      );
    case 'number':
      // `inputmode` on a text field, never `type="number"`: the schema decides it is a number.
      return <Input {...shared} name={name} inputmode="decimal" value={value ?? ''} />;
    default:
      return <Input {...shared} name={name} value={value ?? ''} />;
  }
}

export function AdminActionForm(props: AdminActionFormProps): JSX.Element {
  const labelKey = actionLabelKey(props.action);
  const fields = actionInputFields(props.action);
  // An issue the schema raised against no field of the form is still shown — at the top.
  const loose = props.issues.filter((issue) => !fields.some((field) => field.name === issue.path));

  return (
    <Card header={<h2>{t(labelKey)}</h2>}>
      <form class={styles['form']} method="post" action={props.href}>
        <input type="hidden" name={OPERATION_FIELD} value={props.operation} />
        <input type="hidden" name="name" value={props.action.name} />
        {(props.hidden ?? []).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        <p class={styles['note']}>{props.subject}</p>

        {props.issues.length === 0 ? null : (
          <div class="x-admin-issues" role="alert" tabindex={-1}>
            <h3>{t('admin.form.issues')}</h3>
            <ul>
              {loose.map((issue) => (
                <li>
                  {issue.path === '' ? '' : `${issue.path}: `}
                  {issueText(issue)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {fields.map((field) => {
          const own = props.issues.filter((issue) => issue.path === field.name);
          return (
            <Field
              label={t(field.labelKey)}
              required={field.required && field.control !== 'checkbox'}
              error={own.length === 0 ? undefined : own.map(issueText).join(' ')}
            >
              {(shared) =>
                control(field, props.values[field.name], {
                  id: shared.id,
                  'aria-describedby': shared['aria-describedby'],
                })
              }
            </Field>
          );
        })}

        {props.confirmation === null ? null : <ConfirmationField token={props.confirmation} />}

        <div class={styles['actions']}>
          <Button type="submit" tone={props.action.destructive === true ? 'danger' : undefined}>
            {t(labelKey)}
          </Button>
          <Link appearance="button" variant="ghost" tone="neutral" href={props.cancelHref}>
            {t('admin.form.cancel')}
          </Link>
        </div>
      </form>
    </Card>
  );
}
