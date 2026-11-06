// Pull down at the top of a list to refresh it — the gesture an installed app has no browser to
// give it. No refresh of its own: `onRefresh` is the caller's (`refresh()` from the page's router,
// usually), so `ui` never imports `render`.
//
// Touch only, and only at the top: a pull mid-list is the page's scroll, and a fine pointer gets
// nothing — the caller's toolbar button is the way there, and the way for every keyboard. Inert
// with scripting off; the scroll position stays.

import type { JSX } from 'solid-js';
import { announce } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './PullToRefresh.module.scss';
import { PULL_IDLE, type PullState, pullController } from './pull-refresh-view';

export interface PullToRefreshProps {
  /** Re-reads the content. Its settling — resolved or rejected — ends the busy state. */
  onRefresh: () => Promise<void>;
  /** A rejected refresh, after the busy state ended. Required: a failed refresh is never silent. */
  onError: (error: unknown) => void;
  children: JSX.Element;
  class?: string | undefined;
}

const finePointer = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

const scrolledToTop = (el: HTMLElement): boolean =>
  el.scrollTop <= 0 && (document.scrollingElement?.scrollTop ?? 0) <= 0;

export function PullToRefresh(props: PullToRefreshProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [state, setState] = rt.createSignal<PullState>(PULL_IDLE);
  let root: HTMLDivElement | undefined;

  const pull = pullController(
    () => props.onRefresh(),
    (next) => {
      setState(next);
      if (next.kind === 'refreshing') announce(ui.t(UI_KEYS.refreshBusy));
    },
    (error) => props.onError(error),
  );

  rt.createEffect(() => {
    const el = root;
    if (el === undefined) return;
    let startY = 0;
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined || event.touches.length !== 1) return;
      startY = touch.clientY;
      pull.send({ type: 'start', atTop: scrolledToTop(el), touch: !finePointer() });
    };
    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined || pull.state().kind !== 'pulling') return;
      const dy = touch.clientY - startY;
      // An upward move is the list's scroll, handed back to the browser.
      if (dy <= 0) return;
      event.preventDefault();
      pull.send({ type: 'move', dy });
    };
    const onEnd = (): void => pull.send({ type: 'end' });
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    rt.onCleanup(() => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    });
  });

  const hint = (): string => {
    const now = state();
    if (now.kind === 'refreshing') return ui.t(UI_KEYS.refreshBusy);
    if (now.kind === 'pulling' && now.armed) return ui.t(UI_KEYS.refreshRelease);
    return ui.t(UI_KEYS.refreshPull);
  };
  const distance = (): number => {
    const now = state();
    return now.kind === 'pulling' ? now.distance : 0;
  };

  return (
    <div
      ref={(el: HTMLDivElement) => {
        root = el;
      }}
      class={cx(styles['root'], props.class)}
      data-state={state().kind}
      aria-busy={state().kind === 'refreshing' ? 'true' : undefined}
      style={{ '--pull-distance': `${distance()}px` }}
    >
      {/* Decorative: the announcement and `aria-busy` carry the state to assistive tech. */}
      <div class={styles['indicator']} aria-hidden="true">
        {hint()}
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
