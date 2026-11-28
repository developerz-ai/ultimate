// Enter and exit animation for a keyed list: a new item enters, a removed one exits IN PLACE and
// leaves the document only after. Each item owns its wrapper element and its own root; the rule
// is `presence-list-view.ts`, this file is markup on ui's own Solid runtime.

import type { JSX } from 'solid-js';
import { type Accessor, solid } from '../theme/solid-adapter';
import type { DurationName, EasingName, SpringName } from '../tokens/tokens';
import { animate, type MotionFrame } from './animate';
import { PRESENCE_ENTER } from './Presence';
import { presenceRows } from './presence-list-view';

export interface PresenceListProps<T> {
  each: readonly T[];
  /** Unique per item — its identity across updates. */
  key: (item: T) => string;
  /** The list element. Default `ul`, whose items are `li`. */
  as?: 'ul' | 'ol' | 'div' | undefined;
  enter?: readonly MotionFrame[] | undefined;
  exit?: readonly MotionFrame[] | undefined;
  duration?: DurationName | undefined;
  easing?: EasingName | SpringName | undefined;
  /** Animate the first render's items too. Default false. Read once. */
  appear?: boolean | undefined;
  class?: string | undefined;
  itemClass?: string | undefined;
  /** One item's content; `item` updates in place when a new object arrives under its key. */
  children: (item: Accessor<T>, key: string) => JSX.Element;
}

export function PresenceList<T>(props: PresenceListProps<T>): JSX.Element {
  const rt = solid();
  const [nodes, setNodes] = rt.createSignal<JSX.Element[]>([]);
  const item = (content: JSX.Element, ref: (el: HTMLElement) => void): JSX.Element =>
    props.as === 'div' ? (
      <div ref={ref} class={props.itemClass}>
        {content}
      </div>
    ) : (
      <li ref={ref} class={props.itemClass}>
        {content}
      </li>
    );
  const rows = presenceRows<T, JSX.Element>(
    rt,
    (value) => props.key(value),
    (value, key, ref) => item(props.children(value, key), ref),
    (el, kind) => {
      const enter = props.enter ?? PRESENCE_ENTER;
      const frames = kind === 'enter' ? enter : (props.exit ?? [...enter].reverse());
      return animate(el, frames, {
        duration: props.duration,
        easing: props.easing,
        fill: kind === 'exit' ? 'both' : 'backwards',
      });
    },
    (drawn) => setNodes([...drawn]),
    { appear: props.appear },
  );
  rows.update(props.each);
  rt.createEffect(() => rows.update(props.each));
  rt.onCleanup(() => rows.dispose());

  return (
    <>
      {props.as === 'div' ? (
        <div class={props.class}>{nodes()}</div>
      ) : props.as === 'ol' ? (
        <ol class={props.class}>{nodes()}</ol>
      ) : (
        <ul class={props.class}>{nodes()}</ul>
      )}
    </>
  );
}
