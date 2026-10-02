// The list's batch bar: one native form posted at the LIST's own URL — whose query string is the
// filter "all matching" means — holding which action, over which rows, and the submit. The row
// checkboxes sit in the table and join this form through their `form` attribute, because a form
// cannot hold a table that already holds the filter bar's. No script: selection is a checkbox,
// "every row this filter matches" is a radio, and the server answers with what it did.

import { t } from '@ultimat3/i18n';
import { Button, Checkbox, Radio, Select } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { actionLabelKey } from './action-label';
import { BATCH_OPERATION, OPERATION_FIELD } from './actions';
import styles from './admin.module.scss';
import type { AdminAction } from './registry';

/** The id of the batch form, which every row checkbox names in its `form` attribute. */
export const BATCH_FORM_ID = 'x-admin-batch';

/** The posted field each checked row's id rides in; repeated once per row. */
export const BATCH_IDS_FIELD = 'ids';

/** `checked` (the default) or `all` — every row the list's scope and filters match. */
export const BATCH_SELECTION_FIELD = 'selection';

export interface AdminBatchBarProps {
  /** The batch actions this actor may run on this resource — decided by the caller's gate. */
  readonly actions: readonly AdminAction[];
  /** The list's URL in its current state: the form posts here. */
  readonly href: string;
}

export function AdminBatchBar(props: AdminBatchBarProps): JSX.Element {
  if (props.actions.length === 0) return <span class="x-admin-batch-empty" />;
  return (
    <form id={BATCH_FORM_ID} class={styles['batch']} method="post" action={props.href}>
      <input type="hidden" name={OPERATION_FIELD} value={BATCH_OPERATION} />
      <Select
        name="name"
        aria-label={t('admin.batch.action')}
        options={props.actions.map((action) => ({
          value: action.name,
          label: t(actionLabelKey(action)),
        }))}
      />
      <Radio
        legend={t('admin.batch.over')}
        name={BATCH_SELECTION_FIELD}
        direction="row"
        value="checked"
        options={[
          { value: 'checked', label: t('admin.batch.checked') },
          { value: 'all', label: t('admin.batch.all') },
        ]}
      />
      <Button type="submit" size="sm" variant="secondary">
        {t('admin.batch.run')}
      </Button>
    </form>
  );
}

/** One row's checkbox, joined to the batch form by its id. */
export function BatchCheckbox(props: { readonly id: string; readonly label: string }): JSX.Element {
  return (
    <Checkbox form={BATCH_FORM_ID} name={BATCH_IDS_FIELD} value={props.id} label={props.label} />
  );
}
