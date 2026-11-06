// A SearchableSelect with scripting off — and its first client render: the real `<select>`, with
// `multiple` for many and `<optgroup>` for groups, posting the same `name` and values the enhanced
// control does. Split from `SearchableSelect.tsx` by the 200-line target; it holds no state.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './SearchableSelect.module.scss';
import type { SearchableOption } from './searchable-select-view';
import type { Size } from './variants';

export interface SearchableSelectNativeProps {
  ref: (el: HTMLSelectElement) => void;
  name: string;
  options: readonly SearchableOption[];
  chosen: readonly string[];
  multiple: boolean;
  placeholder: string | undefined;
  id: string | undefined;
  required: boolean | undefined;
  disabled: boolean | undefined;
  size: Size | undefined;
  'aria-label': string | undefined;
  'aria-describedby': string | undefined;
  'aria-invalid': boolean | undefined;
}

export function SearchableSelectNative(props: SearchableSelectNativeProps): JSX.Element {
  return (
    <span class={cx(styles['native'], styles[`size-${props.size ?? 'md'}`])}>
      <select
        ref={props.ref}
        class={styles['select']}
        id={props.id}
        name={props.name}
        multiple={props.multiple}
        required={props.required === true}
        disabled={props.disabled === true}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
      >
        {/* A disabled first option: an unset single field is never a submittable value. */}
        {props.multiple || props.placeholder === undefined ? null : (
          <option value="" disabled selected={props.chosen.length === 0}>
            {props.placeholder}
          </option>
        )}
        {groupsOf(props.options).map((part) =>
          part.group === undefined ? (
            part.options.map((option) => nativeOption(option, props.chosen))
          ) : (
            <optgroup label={part.group}>
              {part.options.map((option) => nativeOption(option, props.chosen))}
            </optgroup>
          ),
        )}
      </select>
    </span>
  );
}

function nativeOption(option: SearchableOption, chosen: readonly string[]): JSX.Element {
  return (
    <option
      value={option.value}
      disabled={option.disabled === true}
      selected={chosen.includes(option.value)}
    >
      {option.label}
    </option>
  );
}

interface OptionRun {
  readonly group: string | undefined;
  readonly options: readonly SearchableOption[];
}

/** Adjacent options of one group as one run — `checkOptions` already refused a split group. */
function groupsOf(options: readonly SearchableOption[]): readonly OptionRun[] {
  const runs: { group: string | undefined; options: SearchableOption[] }[] = [];
  for (const option of options) {
    const last = runs.at(-1);
    if (last !== undefined && last.group === option.group) last.options.push(option);
    else runs.push({ group: option.group, options: [option] });
  }
  return runs;
}
