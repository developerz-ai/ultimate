// Text that arrives piece by piece. One readable node carries the words; the animated split is its
// `aria-hidden` twin, so a screen reader hears the sentence once and unbroken.

import { cx, useUi } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './TextReveal.module.scss';
import { type RevealBy, revealStepMs, splitReveal, TEXT_REVEAL_BACKEND } from './text-reveal-view';

export interface TextRevealProps {
  /** Already-translated text. */
  text: string;
  by?: RevealBy | undefined;
  /** Locale override; defaults to the page's (`useUi().locale`). */
  locale?: string | undefined;
  /** Milliseconds between pieces; shrunk for long texts. */
  stepMs?: number | undefined;
  class?: string | undefined;
}

export function TextReveal(props: TextRevealProps): JSX.Element {
  const by = props.by ?? 'word';
  const pieces = splitReveal(props.text, by, props.locale ?? useUi().locale);
  const step = revealStepMs(pieces.filter((piece) => piece.animate).length, props.stepMs);
  let index = 0;
  return (
    <span
      class={cx(styles['root'], props.class)}
      data-effect-backend={TEXT_REVEAL_BACKEND}
      style={{ '--reveal-step': `${step}ms` }}
    >
      <span class={styles['text']}>{props.text}</span>
      <span aria-hidden="true">
        {pieces.map((piece) =>
          piece.animate ? (
            <span
              class={cx(styles['piece'], by === 'line' && styles['line'])}
              style={{ '--i': index++ }}
            >
              {piece.text}
            </span>
          ) : (
            <span class={styles['rest']}>{piece.text}</span>
          ),
        )}
      </span>
    </span>
  );
}
