// Renders <time datetime="<ISO instant>"> with text formatted in the context
// time zone. The attribute is always the UTC instant so crawlers, tests, and
// other machines read the same value regardless of the viewer's zone.

import type { TimeZone } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import styles from './DateTime.module.scss';
import {
  type DateStyle,
  type DateTimeFormatter,
  dateTimeView,
  type TimeInput,
} from './date-time-view';

export interface DateTimeProps {
  value: TimeInput;
  /** Overrides the context zone. Use for "in the venue's local time" displays. */
  timeZone?: TimeZone | undefined;
  locale?: string | undefined;
  dateStyle?: DateStyle | undefined;
  timeStyle?: DateStyle | undefined;
  format?: DateTimeFormatter | undefined;
  class?: string | undefined;
}

export function DateTime(props: DateTimeProps): JSX.Element {
  const ui = useUi();
  const view = (): { dateTime: string; text: string } =>
    dateTimeView({
      value: props.value,
      locale: props.locale ?? ui.locale,
      timeZone: props.timeZone ?? ui.timeZone,
      ...(props.dateStyle === undefined ? {} : { dateStyle: props.dateStyle }),
      ...(props.timeStyle === undefined ? {} : { timeStyle: props.timeStyle }),
      ...(props.format === undefined ? {} : { format: props.format }),
    });

  return (
    <time class={cx(styles['dateTime'], props.class)} datetime={view().dateTime}>
      {view().text}
    </time>
  );
}
