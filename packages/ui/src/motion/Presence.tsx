// Enter and exit animation for one piece of content. Presence OWNS its wrapper element, so it
// never resolves children: the wrapper is what animates, and what stays in the document while it
// exits. The rule is `presence-view.ts`; this file is markup on ui's own Solid runtime.

import type { JSX } from 'solid-js';
import { solid } from '../theme/solid-adapter';
import type { DurationName, EasingName, SpringName } from '../tokens/tokens';
import { animate, type MotionFrame, type MotionHandle } from './animate';
import { type PresenceState, presenceView } from './presence-view';

/** The elements a Presence may render as: one intrinsic per case (`intrinsic-root.test.ts`). */
export type PresenceTag = 'div' | 'li' | 'section' | 'span';

/** Fade in from half a step below. */
export const PRESENCE_ENTER: readonly MotionFrame[] = [
  { opacity: 0, y: '0.5rem' },
  { opacity: 1, y: 0 },
];

export interface PresenceProps<T> {
  /** Shown unless `false`, `null` or `undefined`. A changed value swaps the content. */
  when: T | false | null | undefined;
  as?: PresenceTag | undefined;
  /** Default `PRESENCE_ENTER`. The last frame is the resting style. */
  enter?: readonly MotionFrame[] | undefined;
  /** Default: `enter`, played backwards. */
  exit?: readonly MotionFrame[] | undefined;
  duration?: DurationName | undefined;
  easing?: EasingName | SpringName | undefined;
  /** A changed `when` exits the old content before the new one enters. Read once. */
  exitBeforeEnter?: boolean | undefined;
  /** Animate the first render too. Default false — server markup is already there. Read once. */
  appear?: boolean | undefined;
  /** Called after an exit finishes and the wrapper has left the document. */
  onExit?: (() => void) | undefined;
  class?: string | undefined;
  /** The content, or a function of the shown value — which is what an exit still renders. */
  children: JSX.Element | ((value: T) => JSX.Element);
}

const SETTLED: MotionHandle = { finished: Promise.resolve(), cancel: () => {}, reverse: () => {} };

export function Presence<T>(props: PresenceProps<T>): JSX.Element {
  const rt = solid();
  let node: HTMLElement | undefined;
  const [state, setState] = rt.createSignal<PresenceState<T>>({ phase: 'absent', shown: null });

  const play = (kind: 'enter' | 'exit'): MotionHandle => {
    if (node === undefined) return SETTLED;
    const enter = props.enter ?? PRESENCE_ENTER;
    const frames = kind === 'enter' ? enter : (props.exit ?? [...enter].reverse());
    return animate(node, frames, {
      duration: props.duration,
      easing: props.easing,
      fill: kind === 'exit' ? 'both' : 'backwards',
    });
  };
  const view = presenceView<T>(props.when, { play }, setState, {
    exitBeforeEnter: props.exitBeforeEnter,
    appear: props.appear,
    onExit: () => props.onExit?.(),
  });
  setState(view.state());

  rt.createEffect(() => view.set(props.when));
  rt.createEffect(() => view.mounted());
  rt.onCleanup(() => view.dispose());

  const ref = (el: HTMLElement): void => {
    node = el;
  };
  // Three reads, so a phase change rewrites one attribute and a swapped value only the content —
  // the wrapper itself is rebuilt only when it enters the document, never mid-animation.
  // `shown` keeps its box across a phase-only change, so the memo stays quiet through one.
  const box = rt.createMemo(() => state().shown);
  const present = rt.createMemo(() => box() !== null);
  const phase = (): string => state().phase;
  const content = (): JSX.Element => {
    const shown = box();
    if (shown === null) return null;
    const children = props.children;
    return typeof children === 'function' ? children(shown.value) : children;
  };
  const wrap = (): JSX.Element => {
    switch (props.as ?? 'div') {
      case 'li':
        return (
          <li ref={ref} class={props.class} data-presence={phase()}>
            {content()}
          </li>
        );
      case 'section':
        return (
          <section ref={ref} class={props.class} data-presence={phase()}>
            {content()}
          </section>
        );
      case 'span':
        return (
          <span ref={ref} class={props.class} data-presence={phase()}>
            {content()}
          </span>
        );
      default:
        return (
          <div ref={ref} class={props.class} data-presence={phase()}>
            {content()}
          </div>
        );
    }
  };

  // The branch inside the JSX: in an island the body runs once.
  return <>{present() ? wrap() : null}</>;
}
