// A searchable text field with suggestions: one `<input list>` plus a `<datalist>`, which is a
// real combobox in every engine — typing, filtering, keyboard and mobile are the platform's, and
// the field still works with scripting off. `onFilter` is the debounced enhancement on top.

import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { DEBOUNCE_DEFAULT_MS, debounce } from '../debounce';
import { UI_KEYS } from '../i18n-keys';
import { iconSearch } from '../icons/glyphs/search';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Combobox.module.scss';
import type { ComboboxOption } from './combobox-filter';
import { filterOptions } from './combobox-filter';
import { Icon } from './Icon';
import type { Size } from './variants';

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  /** The current query. Suggestions are filtered to it before they are rendered. */
  value?: string | undefined;
  /**
   * Fires `debounceMs` after typing stops, and immediately when a suggestion is picked. Left out,
   * the field is a plain filtered datalist — still correct, just not live.
   */
  onFilter?: ((query: string) => void) | undefined;
  /** Debounce window in ms. Read once, when the field mounts. */
  debounceMs?: number | undefined;
  /** Cap on rendered suggestions. */
  limit?: number | undefined;
  id?: string | undefined;
  name?: string | undefined;
  /** Already-translated placeholder. */
  placeholder?: string | undefined;
  size?: Size | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}

export function Combobox(props: ComboboxProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const base = useId('combobox');
  const listId = `${base}-list`;
  const statusId = `${base}-status`;

  // Reads `props.onFilter` at call time, so a caller may swap the handler without rebuilding
  // the timer — and the timer is cancelled on cleanup rather than firing into a dead tree.
  const notify = debounce(
    (query: string) => props.onFilter?.(query),
    props.debounceMs ?? DEBOUNCE_DEFAULT_MS,
  );
  rt.createEffect(() => {
    rt.onCleanup(() => notify.cancel());
  });

  const matches = (): readonly ComboboxOption[] =>
    filterOptions(props.options, props.value ?? '', props.limit);

  const describedBy = (): string =>
    [props['aria-describedby'], statusId].filter((id) => id !== undefined).join(' ');

  return (
    <span class={cx(styles['combobox'], props.class)}>
      <span class={cx(styles['control'], styles[`size-${props.size ?? 'md'}`])}>
        <Icon glyph={iconSearch} class={styles['icon']} size={props.size ?? 'md'} />
        <input
          class={styles['input']}
          type="text"
          list={listId}
          id={props.id}
          name={props.name}
          value={props.value ?? ''}
          placeholder={props.placeholder}
          required={props.required === true}
          disabled={props.disabled === true}
          // The browser's own history dropdown would cover the suggestion list.
          autocomplete="off"
          aria-label={props['aria-label']}
          aria-describedby={describedBy()}
          aria-invalid={ariaBool(props['aria-invalid'])}
          onInput={(event) => notify(event.currentTarget.value)}
          onChange={(event) => {
            // Picking a suggestion is a decision, not a keystroke: it must not wait out the window.
            notify.cancel();
            props.onFilter?.(event.currentTarget.value);
          }}
        />
        <datalist id={listId}>
          {matches().map((option) => (
            <option value={option.value} label={option.hint} />
          ))}
        </datalist>
      </span>
      <p
        id={statusId}
        role="status"
        class={matches().length === 0 ? styles['empty'] : styles['status']}
      >
        {matches().length === 0
          ? ui.t(UI_KEYS.noResults)
          : ui.t(UI_KEYS.suggestions, { count: matches().length })}
      </p>
    </span>
  );
}
