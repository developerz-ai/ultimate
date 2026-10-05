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
  const cls = (): string =>
    cx(styles['container'], styles[`size-${props.size ?? 'lg'}`], props.class);
  const style = (): JSX.CSSProperties => ({
    '--container-gutter': `var(--space-${props.gutter ?? 4})`,
  });

  // One intrinsic per case, never `const Tag = props.as; <Tag>`: the island build compiles a
  // capitalised tag to `createComponent(Tag)` and calls the string (#488, `intrinsic-root.test.ts`).
  switch (props.as ?? 'div') {
    case 'main':
      return (
        <main class={cls()} style={style()}>
          {props.children}
        </main>
      );
    case 'section':
      return (
        <section class={cls()} style={style()}>
          {props.children}
        </section>
      );
    case 'article':
      return (
        <article class={cls()} style={style()}>
          {props.children}
        </article>
      );
    case 'header':
      return (
        <header class={cls()} style={style()}>
          {props.children}
        </header>
      );
    case 'footer':
      return (
        <footer class={cls()} style={style()}>
          {props.children}
        </footer>
      );
    case 'div':
      return (
        <div class={cls()} style={style()}>
          {props.children}
        </div>
      );
  }
}
