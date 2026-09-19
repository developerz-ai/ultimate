// A keyboard key or chord as the user reads it — "⌘K", "Esc", "/". A native `<kbd>`, because a
// keyboard hint is inline code, not a badge: the element carries the meaning, so it works with no
// script and reads as a key to a screen reader.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Kbd.module.scss';

export interface KbdProps {
  /** The key or chord, already translated where a key name is a word. */
  children: JSX.Element;
  class?: string | undefined;
}

export function Kbd(props: KbdProps): JSX.Element {
  return <kbd class={cx(styles['kbd'], props.class)}>{props.children}</kbd>;
}
