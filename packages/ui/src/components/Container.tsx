// Centred measure with a gutter. `margin-inline: auto` and `min()` mean one
// declaration covers every viewport and both writing directions.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Container.module.scss';
import type { SpaceStep } from './variants';

export type ContainerSize = 'prose' | 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ContainerProps {
  children: JSX.Element;
  size?: ContainerSize | undefined;
  gutter?: SpaceStep | undefined;
  as?: 'div' | 'main' | 'section' | 'article' | 'header' | 'footer' | undefined;
  class?: string | undefined;
}

export function Container(props: ContainerProps): JSX.Element {
  const Tag = props.as ?? 'div';
  return (
    <Tag
      class={cx(styles['container'], styles[`size-${props.size ?? 'lg'}`], props.class)}
      style={{ '--container-gutter': `var(--space-${props.gutter ?? 4})` }}
    >
      {props.children}
    </Tag>
  );
}
