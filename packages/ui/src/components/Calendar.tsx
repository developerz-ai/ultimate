// A month you can pick a day from. Server-rendered and correct with no effect run: in link mode
// every day is a link (`hrefFor`), in select mode an APG grid with one tab stop. Inline on a
// booking page, and what `DatePicker`/`DateRangePicker` open. Rules: `calendar-view.ts`.

import { addPlainMonths, now, type PlainDate, plainDateIn } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { iconChevronLeft } from '../icons/glyphs/chevron-left';
import { iconChevronRight } from '../icons/glyphs/chevron-right';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Calendar.module.scss';
import {
  assertBounds,
  type CalendarDay,
  dayLabel,
  firstOfMonth,
  monthGrid,
  monthLabel,
  optionalDateProp as optionalDate,
  rovingDay,
  stepDay,
  type Weekday,
  weekdayLabels,
  weekStartOf,
} from './calendar-view';
import { type DateRange, spanPosition } from './date-range-view';
import { Icon } from './Icon';

interface CalendarBaseProps {
  /** The chosen day, `YYYY-MM-DD`. */
  value?: string | undefined;
  /** A span to mark selected — what `DateRangePicker` passes. */
  range?: DateRange | undefined;
  /** The month shown first; defaults to `value`'s, then `min`'s, then today's in `useUi().timeZone`. */
  month?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  isDisabled?: ((date: PlainDate) => boolean) | undefined;
  /** Overrides the locale's week start (`Intl.Locale#getWeekInfo`). 1 is Monday, 7 Sunday. */
  weekStart?: Weekday | undefined;
  class?: string | undefined;
}

/** Link mode: every enabled day is a link. Works with scripting off. */
export interface CalendarLinkProps extends CalendarBaseProps {
  hrefFor: (date: PlainDate) => string;
  /** The previous and next month's links; omitted, the month does not change. */
  monthHrefFor?: ((month: PlainDate) => string) | undefined;
  onSelect?: undefined;
}

/** Select mode: `role="grid"`, one tab stop, arrows and PageUp/PageDown. An island's. */
export interface CalendarSelectProps extends CalendarBaseProps {
  onSelect: (date: PlainDate) => void;
  hrefFor?: undefined;
  monthHrefFor?: undefined;
}

export type CalendarProps = CalendarLinkProps | CalendarSelectProps;

export function Calendar(props: CalendarProps): JSX.Element {
  const rt = solid();
  const ui = useUi();
  const titleId = useId('calendar');
  const bounds = () => {
    const resolved = {
      min: optionalDate('Calendar min', props.min),
      max: optionalDate('Calendar max', props.max),
      isDisabled: props.isDisabled,
    };
    assertBounds('Calendar', resolved);
    return resolved;
  };
  const value = (): PlainDate | undefined => optionalDate('Calendar value', props.value);
  // With nothing to open on, the month of today in the context's zone — an explicit IANA zone,
  // the request's or the provider's, never the device's.
  const start =
    optionalDate('Calendar month', props.month) ??
    value() ??
    bounds().min ??
    plainDateIn(now(), ui.timeZone);
  const [month, setMonth] = rt.createSignal<PlainDate>(firstOfMonth(start));
  const [focused, setFocused] = rt.createSignal<PlainDate | undefined>(undefined);
  const weekStart = (): Weekday => weekStartOf(ui.locale, props.weekStart);
  const grid = (): readonly (readonly CalendarDay[])[] => monthGrid(month(), weekStart(), bounds());
  const stop = (): PlainDate | undefined =>
    rovingDay(grid(), [focused(), value(), props.range?.from]);
  let table: HTMLTableElement | undefined;

  const selected = (date: PlainDate): boolean =>
    date === value() ||
    (props.range !== undefined && spanPosition(date, props.range) !== undefined);

  const moveTo = (date: PlainDate): void => {
    if (firstOfMonth(date) !== month()) setMonth(firstOfMonth(date));
    setFocused(date);
    const buttons = table === undefined ? [] : [...table.querySelectorAll<HTMLElement>('button')];
    buttons.find((button) => button.dataset['date'] === date)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const from = (event.target as HTMLElement | null)?.dataset?.['date'];
    if (from === undefined || props.onSelect === undefined) return;
    const next = stepDay(from as PlainDate, event.key, {
      ...bounds(),
      dir: ui.dir,
      weekStart: weekStart(),
      shiftKey: event.shiftKey,
    });
    if (next === undefined) return;
    event.preventDefault();
    moveTo(next);
  };

  const cell = (day: CalendarDay): JSX.Element => {
    if (!day.inMonth) {
      return (
        <span class={styles['outside']} aria-hidden="true">
          {day.day}
        </span>
      );
    }
    const onSelect = props.onSelect;
    if (onSelect !== undefined) {
      return (
        <button
          type="button"
          class={styles['day']}
          data-date={day.date}
          aria-label={dayLabel(day.date, ui.locale)}
          tabIndex={stop() === day.date ? 0 : -1}
          disabled={day.disabled}
          onClick={() => {
            setFocused(day.date);
            onSelect(day.date);
          }}
        >
          {day.day}
        </button>
      );
    }
    const hrefFor = props.hrefFor;
    if (day.disabled || hrefFor === undefined) {
      return (
        <span class={styles['day']} aria-disabled="true">
          {day.day}
        </span>
      );
    }
    return (
      <a
        class={styles['day']}
        href={hrefFor(day.date)}
        aria-label={dayLabel(day.date, ui.locale)}
        aria-current={selected(day.date) ? 'date' : undefined}
      >
        {day.day}
      </a>
    );
  };

  /** A month control: a link in link mode (when the caller gave months a URL), a button otherwise. */
  const monthControl = (step: -1 | 1): JSX.Element => {
    const target = (): PlainDate => addPlainMonths(month(), step);
    const label = ui.t(step === 1 ? UI_KEYS.dateNextMonth : UI_KEYS.datePreviousMonth);
    const glyph = step === 1 ? iconChevronRight : iconChevronLeft;
    if (props.onSelect === undefined) {
      const monthHrefFor = props.monthHrefFor;
      if (monthHrefFor === undefined) return null;
      return (
        <a class={styles['nav']} href={monthHrefFor(target())} aria-label={label}>
          <Icon glyph={glyph} size="sm" />
        </a>
      );
    }
    return (
      <button
        type="button"
        class={styles['nav']}
        aria-label={label}
        onClick={() => setMonth(target())}
      >
        <Icon glyph={glyph} size="sm" />
      </button>
    );
  };

  return (
    <div class={cx(styles['calendar'], props.class)}>
      <div class={styles['header']}>
        {monthControl(-1)}
        <p class={styles['title']} id={titleId} aria-live="polite">
          {monthLabel(month(), ui.locale)}
        </p>
        {monthControl(1)}
      </div>
      <table
        class={styles['grid']}
        role={props.onSelect === undefined ? undefined : 'grid'}
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        ref={(el: HTMLTableElement) => {
          table = el;
        }}
      >
        <thead>
          <tr>
            {weekdayLabels(ui.locale, weekStart()).map((weekday) => (
              <th scope="col" abbr={weekday.long} class={styles['weekday']}>
                {weekday.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid().map((week) => (
            <tr>
              {week.map((day) => (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-selected is set only with role="gridcell"
                <td
                  class={styles['cell']}
                  role={props.onSelect === undefined ? undefined : 'gridcell'}
                  aria-selected={
                    props.onSelect === undefined || !day.inMonth
                      ? undefined
                      : selected(day.date)
                        ? 'true'
                        : 'false'
                  }
                  data-span={
                    props.range === undefined ? undefined : spanPosition(day.date, props.range)
                  }
                >
                  {cell(day)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
