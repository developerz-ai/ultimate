// A date range as two native date inputs — `fromName` and `toName` — so a GET filter or a POST
// works with scripting off and on a phone. A fine pointer with a script also gets one calendar:
// the first pick sets the start, the second completes the range. Rules: `date-range-view.ts`.

import type { PlainDate } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { iconCalendarRange } from '../icons/glyphs/calendar-range';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { Calendar } from './Calendar';
import { assertBounds, optionalDateProp, type Weekday } from './calendar-view';
import styles from './DateRangePicker.module.scss';
import { enhancesWithCalendar, inputDate, opensPicker, writeInputDate } from './date-picker-view';
import { type DateRange, orderedRange, pickRange } from './date-range-view';
import { Icon } from './Icon';
import inputStyles from './Input.module.scss';
import { Popover } from './Popover';

export interface DateRangePickerProps {
  /** Already-translated name for the pair, rendered as the `<legend>`. */
  legend: string;
  fromName: string;
  toName: string;
  /** `YYYY-MM-DD` each; anything else is `X_UI_INVALID_VALUE`. */
  from?: string | undefined;
  to?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  isDisabled?: ((date: PlainDate) => boolean) | undefined;
  weekStart?: Weekday | undefined;
  /** The month the calendar opens on with no `from`; else today's in `useUi().timeZone`. */
  month?: string | undefined;
  /** Called with the range in order whenever either end changes. */
  onChange?: ((range: DateRange) => void) | undefined;
  class?: string | undefined;
}

export function DateRangePicker(props: DateRangePickerProps): JSX.Element {
  const rt = solid();
  const ui = useUi();
  const id = useId('range');
  assertBounds('DateRangePicker', {
    min: optionalDateProp('DateRangePicker min', props.min),
    max: optionalDateProp('DateRangePicker max', props.max),
  });
  const [enhanced, setEnhanced] = rt.createSignal(false);
  const [open, setOpen] = rt.createSignal(false);
  const [range, setRange] = rt.createSignal<DateRange>(
    orderedRange({
      from: optionalDateProp('DateRangePicker from', props.from),
      to: optionalDateProp('DateRangePicker to', props.to),
    }),
  );
  let fromInput: HTMLInputElement | undefined;
  let toInput: HTMLInputElement | undefined;

  rt.createEffect(() => {
    setEnhanced(enhancesWithCalendar(typeof matchMedia === 'function' ? matchMedia : undefined));
  });

  const commit = (next: DateRange): void => {
    setRange(next);
    props.onChange?.(next);
  };

  const pick = (date: PlainDate): void => {
    const next = pickRange(range(), date);
    if (fromInput !== undefined && next.range.from !== undefined) {
      writeInputDate(fromInput, next.range.from);
    }
    if (toInput !== undefined) {
      if (next.range.to === undefined) toInput.value = '';
      else writeInputDate(toInput, next.range.to);
    }
    commit(next.range);
    if (next.complete) setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!enhanced() || !opensPicker(event)) return;
    event.preventDefault();
    setOpen(true);
  };

  const field = (end: 'from' | 'to'): JSX.Element => (
    <span class={styles['end']}>
      <label class={styles['label']} for={`${id}-${end}`}>
        {ui.t(end === 'from' ? UI_KEYS.rangeFrom : UI_KEYS.rangeTo)}
      </label>
      <span class={cx(inputStyles['wrap'], inputStyles['size-md'])}>
        <input
          ref={(el: HTMLInputElement) => {
            if (end === 'from') fromInput = el;
            else toInput = el;
          }}
          class={inputStyles['input']}
          type="date"
          id={`${id}-${end}`}
          name={end === 'from' ? props.fromName : props.toName}
          value={(end === 'from' ? props.from : props.to) ?? ''}
          min={props.min}
          max={props.max}
          onKeyDown={onKeyDown}
          onChange={(event: Event) => {
            const date = inputDate((event.currentTarget as HTMLInputElement).value);
            commit(orderedRange({ ...range(), [end]: date }));
          }}
        />
      </span>
    </span>
  );

  return (
    <fieldset class={cx(styles['range'], props.class)}>
      <legend class={styles['legend']}>{props.legend}</legend>
      <div class={styles['ends']}>
        {field('from')}
        {field('to')}
        {enhanced() ? (
          <Popover
            open={open()}
            onOpenChange={setOpen}
            label={ui.t(UI_KEYS.rangeOpen)}
            trigger={(control) => (
              <button
                type="button"
                class={styles['open']}
                id={control.id}
                aria-expanded={ariaBool(control['aria-expanded'])}
                aria-controls={control['aria-controls']}
                aria-haspopup="dialog"
                aria-label={ui.t(UI_KEYS.rangeOpen)}
                onClick={() => setOpen(!open())}
              >
                <Icon glyph={iconCalendarRange} size="sm" />
              </button>
            )}
          >
            <Calendar
              range={range()}
              month={range().from ?? props.month ?? props.min}
              min={props.min}
              max={props.max}
              isDisabled={props.isDisabled}
              weekStart={props.weekStart}
              onSelect={pick}
            />
          </Popover>
        ) : null}
      </div>
    </fieldset>
  );
}
