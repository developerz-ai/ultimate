// Typography primitive. Tone is a foreground or status colour role, size and
// weight are keys of the type scale — so body copy, captions and inline status
// text come from one component and stay legible on both themes.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import type { fontSizeTokens, fontWeightTokens } from '../tokens/tokens';
import styles from './Text.module.scss';

/** Maps 1:1 onto the foreground and status colour roles in `_colors.scss`. */
export const TEXT_TONES = [
  'default',
  'muted',
  'accent',
  'success',
  'warning',
  'danger',
  'info',
] as const;
export type TextTone = (typeof TEXT_TONES)[number];

/** Keyed off the token maps, so a new rung is added once, in `_typography.scss`. */
export type TextSize = keyof typeof fontSizeTokens;
export type TextWeight = keyof typeof fontWeightTokens;

export interface TextProps {
  children: JSX.Element;
  tone?: TextTone | undefined;
  size?: TextSize | undefined;
  weight?: TextWeight | undefined;
  /**
   * Renders a semantic element instead of a span; `p` for flow text. `strong`
   * and `em` carry meaning to assistive tech — `weight` and `tone` do not.
   */
  as?: 'span' | 'p' | 'div' | 'strong' | 'em' | undefined;
  class?: string | undefined;
}

export function Text(props: TextProps): JSX.Element {
  const Tag = props.as ?? 'span';

  // Size and weight are set only when asked for: unset means inherit, so <Text>
  // inside a heading or a caption does not silently reset to the body scale.
  return (
    <Tag
      class={cx(styles['text'], styles[`tone-${props.tone ?? 'default'}`], props.class)}
      style={{
        ...(props.size === undefined ? {} : { '--text-scale': `var(--text-${props.size})` }),
        ...(props.weight === undefined
          ? {}
          : { '--text-strength': `var(--weight-${props.weight})` }),
      }}
    >
      {props.children}
    </Tag>
  );
}
