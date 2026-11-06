// "This metric over that window": the app's presets as links, and a custom window as a GET form of
// two `datetime-local` inputs in a `<details>`. Links and a form, so 0 B of script on a static
// route; the URL is the state (`timeRangeUrl`), so a window survives reload, share and paging.

import type { TimeZone } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { invalidValueError } from '../errors';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import type { TimeRangeUrl } from '../time-range-url';
import { Button } from './Button';
import inputStyles from './Input.module.scss';
import styles from './TimeRangePicker.module.scss';

export interface TimeRangePickerProps {
  /** The window the URL holds, read by `timeRangeUrl` in the loader. */
  range: TimeRangeUrl;
  /**
   * The zone the custom window's wall-clock times are in. Required, and it must be the one the
   * window was read in: there is no ambient zone, and a mismatch would post a different window.
   */
  timeZone: TimeZone;
  /** Already-translated name for the control. */
  label: string;
  class?: string | undefined;
}

export function TimeRangePicker(props: TimeRangePickerProps): JSX.Element {
  const ui = useUi();
  const id = useId('timerange');
  if (props.timeZone !== props.range.timeZone) {
    throw invalidValueError(
      'TimeRangePicker timeZone',
      props.timeZone,
      `the zone the window was read in (${props.range.timeZone})`,
    );
  }

  return (
    <nav class={cx(styles['picker'], props.class)} aria-label={props.label}>
      {props.range.invalid ? (
        <p class={styles['invalid']} role="status">
          {ui.t(UI_KEYS.rangeInvalid)}
        </p>
      ) : null}
      <ul class={styles['presets']}>
        {props.range.presets.map((preset) => (
          <li>
            <a
              class={styles['preset']}
              href={props.range.href({ preset: preset.id })}
              aria-current={props.range.preset === preset.id ? 'true' : undefined}
            >
              {preset.label}
            </a>
          </li>
        ))}
      </ul>
      <details class={styles['custom']} open={props.range.preset === undefined}>
        <summary class={styles['summary']}>{ui.t(UI_KEYS.rangeCustom)}</summary>
        <form class={styles['form']} method="get" action={props.range.action}>
          {props.range.hidden.map(([name, value]) => (
            <input type="hidden" name={name} value={value} />
          ))}
          {(['from', 'to'] as const).map((end) => (
            <span class={styles['end']}>
              <label class={styles['label']} for={`${id}-${end}`}>
                {ui.t(end === 'from' ? UI_KEYS.rangeFrom : UI_KEYS.rangeTo)}
              </label>
              <span class={cx(inputStyles['wrap'], inputStyles['size-md'])}>
                <input
                  class={inputStyles['input']}
                  id={`${id}-${end}`}
                  type="datetime-local"
                  name={props.range.names[end]}
                  value={props.range.local[end]}
                  required
                />
              </span>
            </span>
          ))}
          <Button type="submit" variant="secondary">
            {ui.t(UI_KEYS.rangeApply)}
          </Button>
        </form>
      </details>
    </nav>
  );
}
