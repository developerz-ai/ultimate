// Action buttons, as native form submits. The component renders `actionButtons()` and nothing
// else: if the gate did not return a button, no markup exists for it — not hidden with CSS, not
// disabled. The same gate then decides the POST, so there is one authz system and the UI cannot
// lie about it.
//
// A `<form method="post">` and a `type="submit"`, because an admin screen is `hydrate: 'never'`:
// the browser's own form handling is the client. These were `type="button"` with an `onClick`
// until the screens were mounted — markup that reads as a control and can never act.

import { t } from '@ultimat3/i18n';
import { Button, Field, Input, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { actionButtons } from './action-gate';
import styles from './admin.module.scss';
import type { AdminActor, AdminAuthz, AdminSubject } from './authz';
import { confirmationToken } from './permissions';
import type { AdminAction } from './registry';

/** The posted field that names which write a form is: an action here, a delete on the detail. */
export const OPERATION_FIELD = '_operation';
export const ACTION_OPERATION = 'action';
export const DELETE_OPERATION = 'delete';
/** A batch: posted at the LIST's URL, whose query string is the filter "all matching" means. */
export const BATCH_OPERATION = 'batch';

/** The query parameter a row's URL opens an action's own form with: `<row>?action=<name>`. */
export const ACTION_PARAM = 'action';

/** Where an action's form lives: the row's own URL, asked for that action. */
export const actionFormHref = (rowHref: string, name: string): string =>
  `${rowHref}?${ACTION_PARAM}=${encodeURIComponent(name)}`;

/**
 * The echo a destructive write must carry. Typed, not pre-filled: the token is on screen so it
 * can be copied, and copying it is the deliberate act.
 */
export function ConfirmationField(props: { readonly token: string }): JSX.Element {
  return (
    <Field label={t('admin.actions.confirm.body', { token: props.token })} required>
      {(control) => (
        <Input
          id={control.id}
          aria-describedby={control['aria-describedby']}
          name="confirmation"
          autocomplete="off"
          size="sm"
          required
        />
      )}
    </Field>
  );
}

export interface AdminActionsProps {
  readonly actions: readonly AdminAction[];
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  // `| undefined` is explicit: under exactOptionalPropertyTypes a parent that forwards its own
  // optional subject would otherwise not typecheck.
  readonly subject?: AdminSubject | undefined;
  /**
   * Where the forms post: the URL of the row the action is about (`<base>/<resource>/<id>`), or
   * the admin's base path for an app-wide action. The subject is the URL's, never a hidden field
   * a stale page could have got wrong.
   */
  readonly href: string;
  /** The resource's sealed column names: a `when` never reads one. */
  readonly sealed?: readonly string[] | undefined;
}

export function AdminActions(props: AdminActionsProps): JSX.Element {
  const buttons = actionButtons({
    actions: props.actions,
    actor: props.actor,
    authz: props.authz,
    ...(props.subject === undefined ? {} : { subject: props.subject }),
    ...(props.sealed === undefined ? {} : { sealed: props.sealed }),
  });

  if (buttons.length === 0) return <span class="x-admin-actions-empty" />;

  const expected = confirmationToken(props.subject?.entity ?? 'admin', props.subject?.id ?? '');

  return (
    <span class={styles['actions']}>
      {buttons.map((button) =>
        // An action that takes input is a LINK to its own form — a page the server renders, at
        // the row's URL — and never a button that would post an input nobody typed.
        button.form ? (
          <Link
            appearance="button"
            size="sm"
            variant="secondary"
            tone={button.destructive ? 'danger' : 'neutral'}
            href={actionFormHref(props.href, button.name)}
          >
            {t(button.labelKey)}
          </Link>
        ) : (
          <form class={styles['actionForm']} method="post" action={props.href}>
            <input type="hidden" name={OPERATION_FIELD} value={ACTION_OPERATION} />
            <input type="hidden" name="name" value={button.name} />
            {button.destructive ? <ConfirmationField token={expected} /> : null}
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              tone={button.destructive ? 'danger' : 'neutral'}
            >
              {t(button.labelKey)}
            </Button>
          </form>
        ),
      )}
    </span>
  );
}
