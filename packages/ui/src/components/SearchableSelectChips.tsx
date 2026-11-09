// The chosen values of a many-valued SearchableSelect, as removable chips: each a label and one
// button naming what it removes. Split from `SearchableSelect.tsx` by the 200-line target; it owns
// no state — every removal is the parent's `onRemove`, so a chip and the posted inputs agree.

import type { JSX } from 'solid-js';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './SearchableSelect.module.scss';
import type { SearchableOption } from './searchable-select-view';

export interface SearchableSelectChipsProps {
  /** The chosen options, in the order they were chosen. */
  chosen: readonly SearchableOption[];
  onRemove: (value: string) => void;
  disabled?: boolean | undefined;
}

export function SearchableSelectChips(props: SearchableSelectChipsProps): JSX.Element {
  const ui = useUi();
  return (
    <ul class={styles['chips']} data-chips="true">
      {props.chosen.map((option) => (
        <li class={styles['chip']}>
          <span class={styles['chipLabel']}>{option.label}</span>
          <button
            type="button"
            class={styles['chipRemove']}
            disabled={props.disabled === true}
            aria-label={ui.t(UI_KEYS.selectRemove, { label: option.label })}
            data-remove={option.value}
            // Pressed with the mouse, the field keeps focus: the listbox stays where it was.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onRemove(option.value)}
          >
            <span aria-hidden="true" class={styles['cross']} />
          </button>
        </li>
      ))}
    </ul>
  );
}
