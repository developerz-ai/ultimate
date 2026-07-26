// Action buttons. The component renders `actionButtons()` and nothing else: if the gate did
// not return a button, no markup exists for it — not hidden with CSS, not disabled. The same
// gate then decides the call, so there is one authz system and the UI cannot lie about it.
//
// Fully controlled (no local signals): the route owns "which destructive action is pending",
// which keeps this file a pure function of props and keeps the confirmation state somewhere
// the server round-trip can also see.

import { t } from '@ultimat3/i18n';
import { Dialog } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { type AdminActionButton, actionButtons } from './action-gate';
import type { AdminActor, AdminAuthz, AdminSubject } from './authz';
import { confirmationToken } from './permissions';
import type { AdminAction } from './registry';

export interface AdminActionsProps {
  readonly actions: readonly AdminAction[];
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  // `| undefined` is explicit on every optional prop: under exactOptionalPropertyTypes a
  // parent that forwards its own optional handler would otherwise not typecheck.
  readonly subject?: AdminSubject | undefined;
  /** A non-destructive press, or a confirmed destructive one. */
  readonly onRun?: ((button: AdminActionButton, confirmation: string) => void) | undefined;
  /** A destructive press: the route sets `pending` and re-renders. */
  readonly onRequestConfirm?: ((button: AdminActionButton) => void) | undefined;
  readonly pending?: AdminActionButton | null | undefined;
  readonly confirmation?: string | undefined;
  readonly onConfirmationInput?: ((value: string) => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
}

export function AdminActions(props: AdminActionsProps): JSX.Element {
  const buttons = actionButtons({
    actions: props.actions,
    actor: props.actor,
    authz: props.authz,
    ...(props.subject === undefined ? {} : { subject: props.subject }),
  });

  const expected = confirmationToken(props.subject?.entity ?? 'admin', props.subject?.id ?? '');
  const pending = props.pending ?? null;
  const typed = props.confirmation ?? '';

  const press = (button: AdminActionButton): void => {
    if (button.destructive) props.onRequestConfirm?.(button);
    else props.onRun?.(button, '');
  };

  if (buttons.length === 0) return <span class="x-admin-actions-empty" />;

  return (
    <fieldset class="x-admin-actions" aria-label={t('admin.actions.label')}>
      {buttons.map((button) => (
        <button
          type="button"
          data-destructive={button.destructive ? 'true' : undefined}
          onClick={() => press(button)}
        >
          {t(button.labelKey)}
        </button>
      ))}

      <Dialog
        open={pending !== null}
        title={t('admin.actions.confirm.title')}
        onClose={() => props.onCancel?.()}
      >
        <p>{t('admin.actions.confirm.body', { token: expected })}</p>
        <label for="x-admin-confirm">{t('admin.actions.confirm.label')}</label>
        <input
          id="x-admin-confirm"
          name="confirmation"
          autocomplete="off"
          value={typed}
          onInput={(event: InputEvent) => {
            const target = event.currentTarget;
            props.onConfirmationInput?.(target instanceof HTMLInputElement ? target.value : '');
          }}
        />
        <button
          type="button"
          disabled={typed !== expected}
          onClick={() => {
            if (pending !== null) props.onRun?.(pending, typed);
          }}
        >
          {t('admin.actions.confirm.submit')}
        </button>
      </Dialog>
    </fieldset>
  );
}
