// Two panes and a `role="separator"` between them, its value a percentage of the start pane. Arrows
// step it, Home and End go to the bounds, a pointer drags it, Esc mid-drag restores. Below `md` the
// panes stack and the separator is gone: no gesture on a phone. Storage is the caller's.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { bindPointerDrag } from '../drag/pointer-drag';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './SplitPane.module.scss';
import { paneBounds, paneKey, panePercentAt, paneValue } from './split-pane-view';

export interface SplitPaneProps {
  start: JSX.Element;
  end: JSX.Element;
  /** Controlled: the start pane's share in percent. Pair it with `onResize`. */
  value?: number | undefined;
  /** Where the split sits before any input, and with scripting off. */
  defaultValue: number;
  min?: number | undefined;
  max?: number | undefined;
  /** Each change, in percent. Persisting it is the caller's: storage is never ambient. */
  onResize?: ((percent: number) => void) | undefined;
  /** Already-translated name of the separator; defaults to `ui.pane.resize`. */
  label?: string | undefined;
  class?: string | undefined;
}

export function SplitPane(props: SplitPaneProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const bounds = (): ReturnType<typeof paneBounds> => paneBounds(props.min, props.max);
  const [own, setOwn] = rt.createSignal(paneValue(props.defaultValue, bounds()));
  const value = (): number =>
    props.value === undefined ? own() : paneValue(props.value, bounds());
  const set = (next: number): void => {
    if (next === value()) return;
    setOwn(next);
    props.onResize?.(next);
  };
  let root: HTMLDivElement | undefined;

  const bind = (separator: HTMLDivElement): void => {
    if (typeof document === 'undefined' || typeof separator.setPointerCapture !== 'function')
      return;
    let before = value();
    const at = (x: number): number => {
      const rect = root?.getBoundingClientRect();
      return rect === undefined
        ? value()
        : panePercentAt(x, { start: rect.left, size: rect.width }, bounds(), ui.dir);
    };
    rt.onCleanup(
      bindPointerDrag(separator, {
        start: () => {
          before = value();
        },
        move: (point) => set(at(point.x)),
        drop: (point) => set(at(point.x)),
        cancel: () => set(before),
      }),
    );
  };

  return (
    <div
      class={cx(styles['split'], props.class)}
      style={{ '--split': `${value()}%` }}
      ref={(el: HTMLDivElement) => {
        root = el;
      }}
    >
      <div class={styles['pane']}>{props.start}</div>
      {/* biome-ignore lint/a11y/useSemanticElements: a FOCUSABLE separator with a value; <hr> takes neither */}
      <div
        class={styles['separator']}
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label={props.label ?? ui.t(UI_KEYS.paneResize)}
        aria-valuenow={value()}
        aria-valuemin={bounds().min}
        aria-valuemax={bounds().max}
        ref={bind}
        onKeyDown={(event: KeyboardEvent) => {
          const next = paneKey(event.key, value(), bounds(), ui.dir);
          if (next === null) return;
          event.preventDefault();
          set(next);
        }}
      />
      <div class={styles['pane']}>{props.end}</div>
    </div>
  );
}
