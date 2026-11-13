// One — or many — of a long, closed list, chosen by typing, where the posted value is not the
// label. Without script it IS a native `<select>` (`multiple`, `<optgroup>`), which posts the same
// `name` and values; with script an effect swaps in a WAI-ARIA combobox whose text is never posted:
// hidden inputs carry the chosen values, so a half-typed name cannot reach the server.

import { finiteCount, finiteOption } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { DEBOUNCE_DEFAULT_MS, debounce } from '../debounce';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { COMBOBOX_LIMIT } from './combobox-filter';
import styles from './SearchableSelect.module.scss';
import { SearchableSelectChips } from './SearchableSelectChips';
import { SearchableSelectNative } from './SearchableSelectNative';
import { searchableKeys } from './searchable-select-keys';
import type { SearchableOption, SearchableView } from './searchable-select-view';
import { checkOptions, chosenOptions, searchableView } from './searchable-select-view';
import { thunk } from './thunk';
import type { Size } from './variants';

interface SearchableSelectBase {
  /** The form field name every chosen value posts under. */
  name: string;
  /** Unique by `value`; a group's options adjacent. Chosen values must be among them. */
  options: readonly SearchableOption[];
  /**
   * The caller searches: called `debounceMs` after typing stops, and hands back `options`. The
   * list is then shown as given, never filtered again here; keep the chosen options in it.
   */
  onSearch?: ((query: string) => void) | undefined;
  /** Debounce window for `onSearch`, in ms. Read once. */
  debounceMs?: number | undefined;
  /** Rows shown at most; past it the control says "first N of M". Default `COMBOBOX_LIMIT`. */
  limit?: number | undefined;
  /** Already translated: the no-script placeholder option and the empty field's hint. */
  placeholder?: string | undefined;
  /** Lands on whichever control is live, so `Field`'s `<label for>` names it in both modes. */
  id?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  size?: Size | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}

export interface SearchableSelectOneProps extends SearchableSelectBase {
  multiple?: false | undefined;
  /** The chosen value; absent is nothing chosen. */
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
}

export interface SearchableSelectManyProps extends SearchableSelectBase {
  multiple: true;
  value?: readonly string[] | undefined;
  onChange?: ((values: readonly string[]) => void) | undefined;
}

export type SearchableSelectProps = SearchableSelectOneProps | SearchableSelectManyProps;

const valuesOf = (props: SearchableSelectProps): readonly string[] => {
  if (props.multiple === true) return props.value ?? [];
  return props.value === undefined ? [] : [props.value];
};

export function SearchableSelect(props: SearchableSelectProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const base = props.id ?? useId('searchable-select');
  const listId = `${base}-list`;
  const statusId = `${base}-status`;
  const initial = valuesOf(props);
  const [mounted, setMounted] = rt.createSignal(false);
  const [chosen, setChosen] = rt.createSignal<readonly string[]>(initial);
  // `null` is "not typing": the field shows the chosen label. Free text lives only here.
  const [query, setQuery] = rt.createSignal<string | null>(null);
  const [open, setOpen] = rt.createSignal(false);
  const [active, setActive] = rt.createSignal(-1);
  let select: HTMLSelectElement | undefined;
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let root: HTMLSpanElement | undefined;
  const many = (): boolean => props.multiple === true;

  const notify = debounce(
    (text: string) => props.onSearch?.(text),
    finiteOption('SearchableSelect', 'debounceMs', props.debounceMs ?? DEBOUNCE_DEFAULT_MS),
  );

  // One pass per keystroke: the rows, the status text and its class, and every key handler read
  // the view, and a plain function re-ran the O(n) check and ranking once per read.
  const view = rt.createMemo((): SearchableView => {
    checkOptions(props.options, chosen());
    const limit = finiteCount('SearchableSelect', 'limit', props.limit ?? COMBOBOX_LIMIT, 0);
    // Under `onSearch` the caller already matched: ranking again could drop what it found.
    return props.onSearch === undefined
      ? searchableView(props.options, query() ?? '', limit)
      : searchableView(props.options, '', limit);
  });
  const picked = (): readonly SearchableOption[] => chosenOptions(props.options, chosen());
  const text = (): string => query() ?? (many() ? '' : (picked()[0]?.label ?? ''));

  const commit = (next: readonly string[]): void => {
    setChosen(next);
    if (props.multiple === true) props.onChange?.(next);
    else props.onChange?.(next[0] ?? '');
  };

  const keys = searchableKeys({
    view,
    chosen,
    multiple: many,
    open,
    active,
    query,
    setOpen,
    setActive,
    setQuery,
    commit,
  });

  rt.createEffect(() => {
    const value = valuesOf(props);
    setChosen(value);
  });
  let held = false;
  let form: HTMLFormElement | null = null;
  const reset = (): void => {
    setQuery(null);
    setOpen(false);
    commit(initial);
  };
  // A required control with nothing chosen refuses the submit; typed text never satisfies it.
  // Written only once `required` was ever asked for: an optional control has no refusal to clear.
  let refuses = false;
  const validity = (): void => {
    if (props.required !== true && !refuses) return;
    refuses = props.required === true && chosen().length === 0;
    input?.setCustomValidity(refuses ? ui.t(UI_KEYS.selectNone) : '');
  };
  /**
   * The field's ref. A ref runs before the element is in the document — no form, no focus — so
   * the work waits one microtask, by when the swap has inserted it.
   */
  const adopt = (el: HTMLInputElement): void => {
    input = el;
    queueMicrotask(() => {
      // The swap: the select held focus, so the field takes it — the reader is never dropped.
      if (held) el.focus();
      validity();
      form = el.form;
      form?.addEventListener('reset', reset);
    });
  };
  rt.createEffect(() => {
    held = select !== undefined && document.activeElement === select;
    setMounted(true);
    rt.onCleanup(() => {
      form?.removeEventListener('reset', reset);
      notify.cancel();
    });
  });
  rt.createEffect(() => {
    chosen();
    validity();
  });
  rt.createEffect(() => {
    // On a touch screen the keyboard takes the lower half: the field goes to the top on open, so
    // the list opens into the half that is still visible.
    if (!open() || typeof matchMedia !== 'function') return;
    if (matchMedia('(pointer: coarse)').matches) root?.scrollIntoView?.({ block: 'start' });
  });
  rt.createEffect(() => {
    if (!open() || active() < 0) return;
    // `?.()`: a DOM with no layout (jsdom, a test harness) has no `scrollIntoView`, and a missing
    // scroll is no reason to lose the keystroke that asked for it.
    list?.querySelector(`[id="${base}-row-${active()}"]`)?.scrollIntoView?.({ block: 'nearest' });
  });

  const status = (): string => {
    if (!open()) return '';
    const { rows, total } = view();
    if (total === 0) return ui.t(UI_KEYS.noResults);
    return rows.length < total ? ui.t(UI_KEYS.selectMore, { shown: rows.length, total }) : '';
  };

  const native = (): JSX.Element => {
    // Refused here too: the server render never reaches `view()`, and it is the one that ships.
    checkOptions(props.options, chosen());
    return (
      <SearchableSelectNative
        ref={(el) => {
          select = el;
        }}
        name={props.name}
        options={props.options}
        chosen={chosen()}
        multiple={many()}
        placeholder={props.placeholder}
        id={props.id}
        required={props.required}
        disabled={props.disabled}
        size={props.size}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid']}
      />
    );
  };

  const listbox = (): JSX.Element => (
    <div
      ref={(el: HTMLDivElement) => {
        list = el;
      }}
      id={listId}
      role="listbox"
      class={styles['listbox']}
      aria-label={props['aria-label']}
      aria-multiselectable={many() ? 'true' : undefined}
      hidden={!open()}
    >
      {view().rows.map((row, index) => (
        <>
          {row.opensGroup === undefined ? null : (
            <div class={styles['group']} role="presentation" data-group={row.opensGroup}>
              {row.opensGroup}
            </div>
          )}
          {/* biome-ignore lint/a11y/useFocusableInteractive: focus never leaves the combobox; the active row is aria-activedescendant */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's own onKeyDown is the keyboard path to every row */}
          <div
            id={`${base}-row-${index}`}
            role="option"
            tabindex={-1}
            class={styles['option']}
            aria-selected={chosen().includes(row.option.value) ? 'true' : 'false'}
            aria-disabled={row.option.disabled === true ? 'true' : undefined}
            data-active={index === active() ? 'true' : undefined}
            data-value={row.option.value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => keys.pickRow(index)}
          >
            <span class={styles['optionLabel']}>{row.option.label}</span>
            {row.option.description === undefined ? null : (
              <span class={styles['description']}>{row.option.description}</span>
            )}
          </div>
        </>
      ))}
    </div>
  );

  const enhanced = (): JSX.Element => (
    <span class={styles['enhanced']}>
      {many() && picked().length > 0 ? (
        <SearchableSelectChips
          chosen={picked()}
          disabled={props.disabled}
          onRemove={(value) => commit(chosen().filter((v) => v !== value))}
        />
      ) : null}
      <span class={cx(styles['control'], styles[`size-${props.size ?? 'md'}`])}>
        <input
          ref={adopt}
          class={styles['input']}
          type="text"
          role="combobox"
          id={props.id}
          value={text()}
          placeholder={props.placeholder ?? ui.t(UI_KEYS.selectNone)}
          disabled={props.disabled === true}
          autocomplete="off"
          aria-autocomplete="list"
          aria-expanded={open() ? 'true' : 'false'}
          aria-controls={listId}
          aria-activedescendant={open() && active() >= 0 ? `${base}-row-${active()}` : undefined}
          aria-required={props.required === true ? 'true' : undefined}
          aria-label={props['aria-label']}
          aria-describedby={[props['aria-describedby'], statusId].filter(Boolean).join(' ')}
          aria-invalid={ariaBool(props['aria-invalid'])}
          onInput={(event) => {
            keys.typed(event.currentTarget.value);
            notify(event.currentTarget.value);
          }}
          onKeyDown={keys.onKeyDown}
          onClick={() => keys.toggle()}
          onBlur={() => keys.close()}
        />
        {chosen().length > 0 && (many() || props.required !== true) ? (
          <button
            type="button"
            class={styles['clear']}
            disabled={props.disabled === true}
            data-clear="true"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              keys.close();
              commit([]);
            }}
          >
            {ui.t(UI_KEYS.selectClear)}
          </button>
        ) : null}
      </span>
      {chosen().map((value) => (
        <input type="hidden" name={props.name} value={value} data-posted="true" />
      ))}
      {listbox()}
      <p id={statusId} role="status" class={status() === '' ? styles['quiet'] : styles['status']}>
        {status()}
      </p>
    </span>
  );

  return (
    <span
      ref={(el: HTMLSpanElement) => {
        root = el;
      }}
      class={cx(styles['root'], props.class)}
      data-mounted={mounted() ? 'true' : 'false'}
    >
      {/* A thunk: the one branch the swap re-decides, and what a test re-walks after it. */}
      {thunk(() => (mounted() ? enhanced() : native()))}
    </span>
  );
}
