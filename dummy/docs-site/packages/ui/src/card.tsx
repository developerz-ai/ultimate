import type { JSX } from 'solid-js';
import styles from './card.module.scss';

export interface CardProps {
  readonly title: string;
  readonly children?: JSX.Element;
}

export function Card(props: CardProps) {
  return (
    <section class={styles.card}>
      <h2 class={styles.title}>{props.title}</h2>
      {props.children}
    </section>
  );
}
