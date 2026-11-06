// A destructive confirmation, the one way: a trigger that opens a modal `<dialog>` by invoker
// command (`commandfor` + `show-modal`, no script), a real `<form method="post">` inside it, Cancel
// holding `autofocus` so a stray Enter destroys nothing, Esc closing and the backdrop never.
//
// With `onConfirm` instead of `action` an island runs the act: busy refuses a second submit, a
// refusal keeps the dialog open with the reason in the form summary, focused. The native
// `<dialog>` and `Dialog`'s sheet, not `Dialog` itself: that one opens from an effect and closes
// from a script button, and this one must open, cancel and post with scripting off.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import buttonStyles from './Button.module.scss';
import { buttonClassKeys } from './button-classes';
import styles from './ConfirmDialog.module.scss';
import {
  CONFIRM_IDLE,
  type ConfirmEvent,
  type ConfirmState,
  confirmLabelOf,
  confirmStep,
} from './confirm-dialog-view';
import dialogStyles from './Dialog.module.scss';
import { Form } from './Form';
import type { Tone } from './variants';

interface ConfirmDialogBase {
  /** Already translated. The dialog's accessible name: the question, "Withdraw this post?". */
  title: string;
  /** What happens, in one sentence, read before the act: "Readers lose the page at once." */
  consequence: string;
  /** The verb — "Withdraw post", never "OK". No default; an empty one is `X_UI_INVALID_VALUE`. */
  confirmLabel: string;
  /** The trigger button's label. */
  trigger: string;
  /** The confirm button's tone; `danger` when omitted. */
  tone?: Tone | undefined;
  /** Defaults to the translated `ui.cancel`. */
  cancelLabel?: string | undefined;
  /** A refusal to show on open — the server's, after a native post came back refused. */
  error?: string | undefined;
  /** Hidden inputs, and any gate on the act — a typed name, a reason — with native constraints. */
  children?: JSX.Element | undefined;
  id?: string | undefined;
  class?: string | undefined;
}

/** Without script: the form posts natively to the action's route. */
export interface ConfirmDialogPostProps extends ConfirmDialogBase {
  action: string;
  onConfirm?: undefined;
}

/**
 * In an island: the act runs here. Resolve `undefined` when done (the dialog closes), or an
 * already-translated refusal (it stays open, saying so); a rejection reads as `ui.error.title`.
 */
export interface ConfirmDialogIslandProps extends ConfirmDialogBase {
  onConfirm: (data: FormData) => Promise<string | undefined>;
  action?: undefined;
}

export type ConfirmDialogProps = ConfirmDialogPostProps | ConfirmDialogIslandProps;

/** Chrome ≥ 135, Safari ≥ 26.2, Firefox ≥ 144: the trigger opens the dialog with no script. */
const invokersNative = (): boolean =>
  typeof HTMLButtonElement !== 'undefined' && 'commandForElement' in HTMLButtonElement.prototype;

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const id = props.id ?? useId('confirm');
  const titleId = `${id}-title`;
  const confirmLabel = confirmLabelOf(props.confirmLabel);
  const [state, setState] = rt.createSignal<ConfirmState>(CONFIRM_IDLE);
  let dialog: HTMLDialogElement | undefined;

  const step = (event: ConfirmEvent): boolean => {
    const next = confirmStep(state(), event);
    if (next === null) return false;
    setState(next);
    return true;
  };
  const message = (): string | undefined => {
    const now = state();
    return now.kind === 'refused' ? now.message : props.error;
  };

  const onSubmit = (event: SubmitEvent): void => {
    const onConfirm = props.onConfirm;
    // Cancel is `formmethod="dialog"`: the platform closes the dialog, nothing is confirmed.
    const submitter = event.submitter as HTMLButtonElement | null;
    if (onConfirm === undefined || submitter?.getAttribute('formmethod') === 'dialog') return;
    event.preventDefault();
    if (!step({ type: 'submit' })) return;
    const form = event.currentTarget as HTMLFormElement;
    onConfirm(new FormData(form)).then(
      (refusal) => {
        step({ type: 'settled', refusal });
        if (refusal === undefined) dialog?.close();
      },
      () => step({ type: 'settled', refusal: ui.t(UI_KEYS.error) }),
    );
  };

  return (
    <div class={cx(styles['root'], props.class)}>
      <button
        type="button"
        class={cx(
          ...buttonClassKeys({ variant: 'secondary', tone: props.tone ?? 'danger' }).map(
            (key) => buttonStyles[key],
          ),
        )}
        commandfor={id}
        command="show-modal"
        onClick={() => {
          // The gap an engine without invoker commands leaves, filled where there is a script.
          if (!invokersNative() && dialog !== undefined && !dialog.open) dialog.showModal();
        }}
      >
        <span class={buttonStyles['label']}>{props.trigger}</span>
      </button>
      {/* No backdrop handler at all: a confirmation is never dismissed by a stray click. */}
      <dialog
        ref={(el: HTMLDialogElement) => {
          dialog = el;
        }}
        id={id}
        class={cx(dialogStyles['dialog'], dialogStyles['size-sm'], styles['dialog'])}
        aria-labelledby={titleId}
        onClose={() => step({ type: 'closed' })}
      >
        <div class={dialogStyles['panel']}>
          <header class={dialogStyles['header']}>
            <h2 class={dialogStyles['title']} id={titleId}>
              {props.title}
            </h2>
          </header>
          <div class={dialogStyles['body']}>
            <Form
              method="post"
              action={props.action}
              error={message()}
              busy={state().kind === 'busy'}
              onSubmit={onSubmit}
              actions={
                <div class={styles['actions']}>
                  {/* `autofocus`: showModal() lands here, so Enter straight after open cancels. */}
                  <button
                    type="submit"
                    formmethod="dialog"
                    formnovalidate
                    autofocus
                    class={cx(
                      ...buttonClassKeys({ variant: 'secondary' }).map((key) => buttonStyles[key]),
                    )}
                  >
                    <span class={buttonStyles['label']}>
                      {props.cancelLabel ?? ui.t(UI_KEYS.cancel)}
                    </span>
                  </button>
                  <button
                    type="submit"
                    class={cx(
                      ...buttonClassKeys({ tone: props.tone ?? 'danger' }).map(
                        (key) => buttonStyles[key],
                      ),
                    )}
                    aria-busy={state().kind === 'busy' ? 'true' : undefined}
                  >
                    <span class={buttonStyles['label']}>{confirmLabel}</span>
                  </button>
                </div>
              }
            >
              <p class={styles['consequence']}>{props.consequence}</p>
              {props.children}
            </Form>
          </div>
        </div>
      </dialog>
    </div>
  );
}
