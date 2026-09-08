// The one way to render a toast queue: the store's VISIBLE slice, inside the region that owns the
// live semantics. The half that was missing — `Toast` and `ToastRegion` shipped with no store, so
// every app wrote its own queue, its own dwell and its own pause rules.
//
// Toasts over the cap are not drawn and not counted on screen: they are still queued, and their
// dwell has not started. A "+3 more" badge would be a message about messages, in a corner the
// reader is already being asked to look away to.

import type { JSX } from 'solid-js';
import type { Politeness } from '../a11y';
import { type ToastItem, visibleToasts } from '../toast/toast-state';
import type { ToastStore } from '../toast/toast-store';
import { useToasts } from '../toast/use-toasts';
import { Button } from './Button';
import { Toast, type ToastPlacement, ToastRegion } from './Toast';

export interface ToasterProps {
  /** The queue. One per app — `createToastStore()` in the island that mounts this. */
  store: ToastStore;
  /** Already-translated landmark name, e.g. "Notifications". */
  label: string;
  politeness?: Politeness | undefined;
  placement?: ToastPlacement | undefined;
  /** Already-translated; falls back to the `ui.dismiss` catalog key. */
  dismissLabel?: string | undefined;
  class?: string | undefined;
}

export function Toaster(props: ToasterProps): JSX.Element {
  const queue = useToasts(props.store);

  /**
   * One undo-shaped control, or nothing. A toast never carries the only affordance for an action:
   * it disappears on a timer, and a keyboard user who was typing when it arrived never reached it.
   * Taking the undo also dismisses — the offer has been answered.
   */
  const actionSlot = (item: ToastItem): JSX.Element => {
    const action = item.action;
    if (action === undefined) return null;
    return (
      <Button
        size="sm"
        variant="ghost"
        tone={item.tone}
        onClick={() => {
          action.onAction();
          props.store.dismiss(item.id);
        }}
      >
        {action.label}
      </Button>
    );
  };

  return (
    <ToastRegion
      label={props.label}
      politeness={props.politeness}
      placement={props.placement}
      class={props.class}
      onHold={(reason) => props.store.hold(reason)}
      onRelease={(reason) => props.store.release(reason)}
    >
      {visibleToasts(queue()).map((item) => (
        <Toast
          title={item.title}
          tone={item.tone}
          dismissLabel={props.dismissLabel}
          action={actionSlot(item)}
          onDismiss={() => props.store.dismiss(item.id)}
        >
          {item.message}
        </Toast>
      ))}
    </ToastRegion>
  );
}
