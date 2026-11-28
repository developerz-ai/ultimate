// Text with the shared highlight sweep. The sweep is ui's `@mixin shimmer` (the one Skeleton
// paints); this component only clips it to the glyphs.

import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './Shimmer.module.scss';

export interface ShimmerProps {
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function Shimmer(props: ShimmerProps): JSX.Element {
  return (
    <span class={cx(styles['shimmer'], props.class)} data-effect-backend="css">
      {props.children}
    </span>
  );
}
