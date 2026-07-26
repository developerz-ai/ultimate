// Supplementary hint, shown on hover AND on keyboard focus. CSS-only, so it
// costs no JS; the content is wired with `aria-describedby`, never `title`,
// because `title` is unreachable by keyboard and untranslatable by the platform.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import styles from './Tooltip.module.scss';

export interface TooltipProps {
  /** Already-translated hint text. Never the element's only accessible name. */
  content: string;
  children: (control: { 'aria-describedby': string }) => JSX.Element;
  placement?: 'block-start' | 'block-end' | undefined;
  class?: string | undefined;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const id = useId('tooltip');
  return (
    <span class={cx(styles['wrap'], props.class)}>
      {props.children({ 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        class={cx(styles['bubble'], styles[`placement-${props.placement ?? 'block-start'}`])}
      >
        {props.content}
      </span>
    </span>
  );
}
