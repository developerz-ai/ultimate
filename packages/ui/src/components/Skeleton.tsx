// Loading placeholder. Sized by the caller so the real content lands in the same
// box — a skeleton that changes size on load is just a slower layout shift.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Skeleton.module.scss';

export interface SkeletonProps {
  /** CSS length; must match the real content's box to keep CLS at 0. */
  width?: string | undefined;
  height?: string | undefined;
  shape?: 'text' | 'block' | 'circle' | undefined;
  /** Repeat as stacked lines, e.g. a paragraph placeholder. */
  lines?: number | undefined;
  class?: string | undefined;
}

export function Skeleton(props: SkeletonProps): JSX.Element {
  const one = (index: number): JSX.Element => (
    <span
      class={cx(styles['skeleton'], styles[`shape-${props.shape ?? 'text'}`])}
      style={{
        '--skeleton-w': index > 0 && props.shape !== 'circle' ? '70%' : (props.width ?? '100%'),
        '--skeleton-h': props.height ?? '1em',
      }}
    />
  );

  return (
    <span aria-hidden="true" class={cx(styles['group'], props.class)}>
      {Array.from({ length: Math.max(1, props.lines ?? 1) }, (_unused, index) => one(index))}
    </span>
  );
}
