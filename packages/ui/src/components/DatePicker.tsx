// A date field that is a native `<input type="date">` first, always: on the server, with scripting
// off and on a coarse pointer it is all there is, and it is the value either way, so the form posts
// the same thing. A fine pointer with a script also gets a button opening a `Calendar` popover.

import type { PlainDate } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { iconCalendar } from '../icons/glyphs/calendar';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { Calendar } from './Calendar';
import { assertBounds, optionalDateProp, type Weekday } from './calendar-view';
import styles from './DatePicker.module.scss';
import { enhancesWithCalendar, inputDate, opensPicker, writeInputDate } from './date-picker-view';
import { Icon } from './Icon';
import inputStyles from './Input.module.scss';
import { Popover } from './Popover';

export interface DatePickerProps {
  /** The form field name: the post is the native input's, `YYYY-MM-DD`. */
  name: string;
  id?: string | undefined;
  /** `YYYY-MM-DD`; anything else is `X_UI_INVALID_VALUE`. */
  value?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  /** Days the calendar refuses. The native input cannot express it; validate on the server too. */
  isDisabled?: ((date: PlainDate) => boolean) | undefined;
  weekStart?: Weekday | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The month the calendar opens on with no value; else today's in `useUi().timeZone`. */
  month?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  onChange?: ((date: PlainDate | undefined) => void) | undefined;
  class?: string | undefined;
}

export function DatePicker(props: DatePickerProps): JSX.Element {
  const rt = solid();
  const ui = useUi();
  const fallbackId = useId('date');
  assertBounds('DatePicker', {
    min: optionalDateProp('DatePicker min', props.min),
    max: optionalDateProp('DatePicker max', props.max),
  });
  const [enhanced, setEnhanced] = rt.createSignal(false);
  const [open, setOpen] = rt.createSignal(false);
  const [current, setCurrent] = rt.createSignal<PlainDate | undefined>(
    optionalDateProp('DatePicker value', props.value),
  );
  let input: HTMLInputElement | undefined;

  // After mount, never during render: the first client render equals the server's input.
  rt.createEffect(() => {
    setEnhanced(enhancesWithCalendar(typeof matchMedia === 'function' ? matchMedia : undefined));
  });

  const pick = (date: PlainDate): void => {
    if (input !== undefined) writeInputDate(input, date);
    setCurrent(date);
    setOpen(false);
  };

  return (
    <span class={cx(styles['picker'], props.class)}>
      <span class={cx(inputStyles['wrap'], inputStyles['size-md'], styles['field'])}>
        <input
          ref={(el: HTMLInputElement) => {
            input = el;
          }}
          class={inputStyles['input']}
          type="date"
          id={props.id ?? fallbackId}
          name={props.name}
          value={props.value ?? ''}
          min={props.min}
          max={props.max}
          required={props.required === true}
          disabled={props.disabled === true}
          aria-label={props['aria-label']}
          aria-describedby={props['aria-describedby']}
          aria-invalid={ariaBool(props['aria-invalid'])}
          onKeyDown={(event: KeyboardEvent) => {
            if (!enhanced() || !opensPicker(event)) return;
            event.preventDefault();
            setOpen(true);
          }}
          onChange={(event: Event) => {
            const date = inputDate((event.currentTarget as HTMLInputElement).value);
            setCurrent(date);
            props.onChange?.(date);
          }}
        />
      </span>
      {enhanced() ? (
        <Popover
          open={open()}
          onOpenChange={setOpen}
          label={ui.t(UI_KEYS.dateOpen)}
          trigger={(control) => (
            <button
              type="button"
              class={styles['open']}
              id={control.id}
              aria-expanded={ariaBool(control['aria-expanded'])}
              aria-controls={control['aria-controls']}
              aria-haspopup="dialog"
              aria-label={ui.t(UI_KEYS.dateOpen)}
              disabled={props.disabled === true}
              onClick={() => setOpen(!open())}
            >
              <Icon glyph={iconCalendar} size="sm" />
            </button>
          )}
        >
          <Calendar
            value={current()}
            month={current() ?? props.month ?? props.min}
            min={props.min}
            max={props.max}
            isDisabled={props.isDisabled}
            weekStart={props.weekStart}
            onSelect={pick}
          />
        </Popover>
      ) : null}
    </span>
  );
}
