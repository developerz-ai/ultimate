// Presence's rule, pure: what is shown, and in which phase, as `when` changes. An exiting value
// is held until its exit finishes; a reversal mid-flight reverses the running animation from where
// it is; a stale run settling late changes nothing. `Presence.tsx` renders it.

import type { MotionHandle } from './animate';

export type PresencePhase = 'absent' | 'entering' | 'present' | 'exiting';

export interface PresenceState<T> {
  readonly phase: PresencePhase;
  /** The value on screen — boxed, so a falsy value (`0`) can still be shown. */
  readonly shown: { readonly value: T } | null;
}

/** Starts an animation on the node now on screen. */
export interface PresenceDriver {
  play(kind: 'enter' | 'exit'): MotionHandle;
}

export interface PresenceViewOptions {
  /** A changed value waits for the old one to exit, then enters. Otherwise it swaps in place. */
  readonly exitBeforeEnter?: boolean | undefined;
  /** Enter on the first render too. Default false: server markup is already on screen. */
  readonly appear?: boolean | undefined;
  readonly onExit?: (() => void) | undefined;
}

export interface PresenceView<T> {
  set(next: T | false | null | undefined): void;
  /** The node is in the document: an `appear` enter may start. */
  mounted(): void;
  state(): PresenceState<T>;
  dispose(): void;
}

const isShown = <T>(value: T | false | null | undefined): value is T =>
  value !== false && value !== null && value !== undefined;

/** `when` is hidden at `false`, `null` and `undefined`; every other value is shown. */
export function presenceView<T>(
  initial: T | false | null | undefined,
  driver: PresenceDriver,
  notify: (next: PresenceState<T>) => void,
  options: PresenceViewOptions = {},
): PresenceView<T> {
  let current: PresenceState<T> = isShown(initial)
    ? { phase: options.appear === true ? 'entering' : 'present', shown: { value: initial } }
    : { phase: 'absent', shown: null };
  let run: MotionHandle | null = null;
  let queued: { readonly value: T } | null = null;
  let disposed = false;

  const write = (next: PresenceState<T>): void => {
    current = next;
    notify(next);
  };
  const start = (kind: 'enter' | 'exit'): void => {
    const mine = driver.play(kind);
    run = mine;
    void mine.finished.then(() => {
      if (!disposed && run === mine) settle();
    });
  };
  /** Turn a running animation around: the phase flips, the animation plays back from here. */
  const reverse = (phase: 'entering' | 'exiting'): void => {
    run?.reverse();
    write({ ...current, phase });
  };
  const settle = (): void => {
    run = null;
    if (current.phase === 'entering') write({ ...current, phase: 'present' });
    if (current.phase !== 'exiting') return;
    write({ phase: 'absent', shown: null });
    options.onExit?.();
    if (queued === null) return;
    const next = queued;
    queued = null;
    write({ phase: 'entering', shown: next });
    start('enter');
  };

  const hide = (): void => {
    queued = null;
    if (current.phase === 'entering') reverse('exiting');
    else if (current.phase === 'present') {
      write({ ...current, phase: 'exiting' });
      start('exit');
    }
  };
  const show = (next: T): void => {
    if (current.shown === null) {
      write({ phase: 'entering', shown: { value: next } });
      start('enter');
      return;
    }
    if (current.shown.value === next) {
      queued = null;
      if (current.phase === 'exiting') reverse('entering');
      return;
    }
    if (options.exitBeforeEnter === true) {
      queued = { value: next };
      if (current.phase === 'present') {
        write({ ...current, phase: 'exiting' });
        start('exit');
      } else if (current.phase === 'entering') reverse('exiting');
      return;
    }
    // Swapped in place; one leaving turns back, since what it showed is wanted again.
    const leaving = current.phase === 'exiting';
    if (leaving) run?.reverse();
    write({ phase: leaving ? 'entering' : current.phase, shown: { value: next } });
  };

  return {
    set(next) {
      if (disposed) return;
      if (isShown(next)) show(next);
      else hide();
    },
    mounted() {
      if (!disposed && current.phase === 'entering' && run === null) start('enter');
    },
    state: () => current,
    dispose() {
      if (disposed) return;
      disposed = true;
      run?.cancel();
      run = null;
    },
  };
}
