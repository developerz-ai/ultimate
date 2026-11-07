// Whether a live view is live: a static dot whose SHAPE is the state, with the word beside it —
// live, reconnecting, paused, offline. Never blinks: a pulse is motion a reader cannot stop and
// says nothing the word does not. A change of state is announced once; a tick never is.

import type { JSX } from 'solid-js';
import { announce } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './LiveIndicator.module.scss';

export const LIVE_INDICATOR_STATES = ['live', 'reconnecting', 'paused', 'offline'] as const;
export type LiveIndicatorState = (typeof LIVE_INDICATOR_STATES)[number];

const WORDS = {
  live: UI_KEYS.liveLive,
  reconnecting: UI_KEYS.liveReconnecting,
  paused: UI_KEYS.livePaused,
  offline: UI_KEYS.liveOffline,
} as const;

export interface LiveIndicatorProps {
  state: LiveIndicatorState;
  class?: string | undefined;
}

export function LiveIndicator(props: LiveIndicatorProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const word = (): string => ui.t(WORDS[props.state]);
  // The first state is what the page rendered with — on screen already, not news.
  let previous: LiveIndicatorState | undefined;
  rt.createEffect(() => {
    const state = props.state;
    if (previous !== undefined && previous !== state) announce(ui.t(WORDS[state]));
    previous = state;
  });
  return (
    <span class={cx(styles['indicator'], props.class)} data-live={props.state}>
      <span class={styles['dot']} aria-hidden="true" />
      <span class={styles['word']}>{word()}</span>
    </span>
  );
}
