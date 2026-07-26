// Flex layout primitive. Gap comes from the space scale as a custom property, so
// there is no class per step, and `row` uses `flex-direction: row` — which the
// browser already mirrors under `dir="rtl"`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Stack.module.scss';
import type { Align, SpaceStep } from './variants';

export interface StackProps {
  children: JSX.Element;
  direction?: 'row' | 'column' | undefined;
  gap?: SpaceStep | undefined;
  align?: Align | undefined;
  justify?: Align | undefined;
  wrap?: boolean | undefined;
  /** Renders a semantic element instead of a div. */
  as?: 'div' | 'ul' | 'ol' | 'nav' | 'section' | 'header' | 'footer' | undefined;
  class?: string | undefined;
}

const ALIGN: Readonly<Record<Align, string>> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  between: 'space-between',
};

export function Stack(props: StackProps): JSX.Element {
  const Tag = props.as ?? 'div';
  return (
    <Tag
      class={cx(
        styles['stack'],
        styles[`direction-${props.direction ?? 'column'}`],
        props.wrap === true && styles['wrap'],
        props.class,
      )}
      style={{
        '--stack-gap': `var(--space-${props.gap ?? 4})`,
        '--stack-align': ALIGN[props.align ?? 'stretch'],
        '--stack-justify': ALIGN[props.justify ?? 'start'],
      }}
    >
      {props.children}
    </Tag>
  );
}
