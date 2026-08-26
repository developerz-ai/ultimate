// Loading placeholder. Sized by the caller so the real content lands in the same
// box — a skeleton that changes size on load is just a slower layout shift.

import { finiteCount } from '@ultimat3/core';
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
  // `Math.max` IS NOT A VALIDATOR — it propagates `NaN`, so `Math.max(1, NaN)` is `NaN` and
  // `Array.from({ length: NaN })` is `[]`: the placeholder that holds the box while content loads
  // rendered nothing at all, which is the layout shift it exists to prevent. The clamp stays, and
  // it is the screened value it clamps — `lines: 0` still means one line, exactly as before.
  const lines = (): number => Math.max(1, finiteCount('Skeleton', 'lines', props.lines ?? 1, 0));

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
      {Array.from({ length: lines() }, (_unused, index) => one(index))}
    </span>
  );
}
