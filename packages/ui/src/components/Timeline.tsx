// What happened, in order: when, what, a marker and a tone. An `<ol>` because the order IS the
// content; day headers come from `groupBy`, already formatted. Server-only, no signal: an activity
// feed is this plus `InfiniteScroll` and `RelativeTime`, never a component of its own.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { Icon } from './Icon';
import type { IconGlyph } from './icon-glyph';
import styles from './Timeline.module.scss';
import { timelineGroups } from './timeline-view';
import type { Tone } from './variants';

export interface TimelineItem {
  /** Stable identity, rendered as `data-key` so a test or a live update can find the row. */
  key: string;
  /** The `<time>` slot: a `DateTime` or a `RelativeTime`, formatted in the caller's zone. */
  when: JSX.Element;
  /** What happened, already translated. */
  title: JSX.Element;
  detail?: JSX.Element | undefined;
  /** The marker's colour. The word a tone stands for is the caller's: no status map ships. */
  tone?: Tone | undefined;
  /** Drawn in the marker; decorative, since `title` says what happened. */
  icon?: IconGlyph | undefined;
}

export interface TimelineProps {
  items: readonly TimelineItem[];
  /** Already-translated accessible name for the list. */
  label: string;
  /** A day header per run of items: answer a label already formatted in the caller's zone. */
  groupBy?: ((item: TimelineItem) => string) | undefined;
  class?: string | undefined;
}

export function Timeline(props: TimelineProps): JSX.Element {
  const row = (item: TimelineItem): JSX.Element => (
    <li class={cx(styles['item'], styles[`tone-${item.tone ?? 'neutral'}`])} data-key={item.key}>
      <span class={styles['marker']} aria-hidden="true">
        {item.icon === undefined ? null : <Icon glyph={item.icon} size="sm" />}
      </span>
      <div class={styles['body']}>
        <div class={styles['title']}>{item.title}</div>
        <div class={styles['when']}>{item.when}</div>
        {item.detail === undefined ? null : <div class={styles['detail']}>{item.detail}</div>}
      </div>
    </li>
  );

  return (
    <div class={cx(styles['timeline'], props.class)}>
      {timelineGroups(props.items, props.groupBy).map((group) => [
        group.label === undefined ? null : <p class={styles['day']}>{group.label}</p>,
        <ol class={styles['list']} aria-label={group.label ?? props.label}>
          {group.items.map(row)}
        </ol>,
      ])}
    </div>
  );
}
