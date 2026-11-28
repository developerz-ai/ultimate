// The page-wide motion pause, WCAG 2.2.2: one control that stops every animation on the page —
// CSS through `html[data-motion="paused"]` (`_motion.scss`), scripts through `motionAllowed()`.
// The choice is remembered; its label names what a press will do.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { browserMotionHost, setMotionPaused, storedMotionPaused } from '../motion/motion-gate';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './MotionToggle.module.scss';

export interface MotionToggleProps {
  class?: string | undefined;
}

export function MotionToggle(props: MotionToggleProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  // Moving until the effect reads the page: the server cannot know a stored choice.
  const [paused, setPaused] = rt.createSignal(false);

  rt.createEffect(() => {
    const host = browserMotionHost();
    if (host === null) return;
    if (storedMotionPaused() && !host.paused()) setMotionPaused(true);
    setPaused(host.paused());
    // A second toggle on the page, or a script, stays in step with this one.
    rt.onCleanup(host.watch(() => setPaused(host.paused())));
  });

  return (
    <button
      type="button"
      class={cx(styles['toggle'], props.class)}
      data-motion-toggle={paused() ? 'paused' : 'running'}
      onClick={() => {
        setMotionPaused(!paused());
        setPaused(!paused());
      }}
    >
      {paused() ? ui.t(UI_KEYS.motionResume) : ui.t(UI_KEYS.motionPause)}
    </button>
  );
}
