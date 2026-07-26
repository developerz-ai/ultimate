// Grid layout primitive. The default is an intrinsic responsive grid
// (`auto-fit` + `minmax`) so most layouts need no breakpoint at all.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Grid.module.scss';
import type { SpaceStep } from './variants';

export interface GridProps {
  children: JSX.Element;
  /** Fixed track count. Omit for the intrinsic `auto-fit` behaviour. */
  columns?: number | undefined;
  /** Minimum track width for the intrinsic grid. */
  minColumn?: string | undefined;
  gap?: SpaceStep | undefined;
  rowGap?: SpaceStep | undefined;
  as?: 'div' | 'ul' | 'ol' | 'section' | undefined;
  class?: string | undefined;
}

export function Grid(props: GridProps): JSX.Element {
  const Tag = props.as ?? 'div';
  const tracks = (): string =>
    props.columns === undefined
      ? `repeat(auto-fit, minmax(${props.minColumn ?? '16rem'}, 1fr))`
      : `repeat(${props.columns}, minmax(0, 1fr))`;

  return (
    <Tag
      class={cx(styles['grid'], props.class)}
      style={{
        '--grid-tracks': tracks(),
        '--grid-gap': `var(--space-${props.gap ?? 4})`,
        '--grid-row-gap': `var(--space-${props.rowGap ?? props.gap ?? 4})`,
      }}
    >
      {props.children}
    </Tag>
  );
}
