// "3 minutes ago" with the absolute instant in both `datetime` and `title`, so
// hovering (or reading the DOM) always recovers the exact time.

import type { TimeZone } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import { type DateTimeFormatter, dateTimeView, type TimeInput } from './date-time-view';
import styles from './RelativeTime.module.scss';
import { relativeTimeText } from './relative-time-view';

export interface RelativeTimeProps {
  value: TimeInput;
  /** Pass explicitly for SSR so server and client render the same string. */
  now?: TimeInput | undefined;
  locale?: string | undefined;
  timeZone?: TimeZone | undefined;
  numeric?: 'always' | 'auto' | undefined;
  format?: DateTimeFormatter | undefined;
  class?: string | undefined;
}

export function RelativeTime(props: RelativeTimeProps): JSX.Element {
  const ui = useUi();
  const absolute = (): { dateTime: string; text: string } =>
    dateTimeView({
      value: props.value,
      locale: props.locale ?? ui.locale,
      timeZone: props.timeZone ?? ui.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(props.format === undefined ? {} : { format: props.format }),
    });

  return (
    <time
      class={cx(styles['relative'], props.class)}
      datetime={absolute().dateTime}
      title={absolute().text}
    >
      {relativeTimeText({
        value: props.value,
        locale: props.locale ?? ui.locale,
        ...(props.now === undefined ? {} : { now: props.now }),
        ...(props.numeric === undefined ? {} : { numeric: props.numeric }),
      })}
    </time>
  );
}
