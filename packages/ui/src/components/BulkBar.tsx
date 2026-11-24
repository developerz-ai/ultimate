// The bar under a selection: how many rows it names, the caller's actions in a slot, and — when the
// list's filter matches more than the page — the "all matching" box. The count is a status region,
// so a screen reader hears each change without moving focus; a no-script form has no count.
//
// "All matching" is a native checkbox posting the FILTER under its own name, never a list of ids:
// with scripting off it is the same control in the same form as the row boxes.

import { finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './BulkBar.module.scss';

/** Every row the list's filter matches, across pages: what the "all matching" box posts. */
export interface SelectionMatching {
  /** The field name the box posts under; the server reads its value as the filter to re-run. */
  readonly name: string;
  /** The list's filter as the server reads it back — the query string, a saved view id. Never ids. */
  readonly filter: string;
  /** How many rows the filter matches across every page. */
  readonly count: number;
}

export interface BulkBarProps {
  /**
   * Rows selected now. Absent — a scripting-off form, whose boxes change with nothing to recount
   * them — the bar shows no count and stays in reach as if something were selected.
   */
  count?: number | undefined;
  /** The bulk actions: buttons that submit the selection's form or call back. */
  children?: JSX.Element | undefined;
  /** Present when the filter matches more rows than the page shows. */
  matching?: SelectionMatching | undefined;
  /** Whether "all matching" is the selection. */
  allMatching?: boolean | undefined;
  /**
   * Callback mode for the "all matching" box: once it answers, the box shows `allMatching` again,
   * so a change the caller declines is not left ticked. Absent, it is a plain form control.
   */
  onAllMatching?: ((on: boolean) => void) | undefined;
  /** Callback mode: the clear button. Absent, no clear button — a no-script page reloads instead. */
  onClear?: (() => void) | undefined;
  /** The id of the `<form>` the "all matching" box submits with. */
  form?: string | undefined;
  class?: string | undefined;
}

export function BulkBar(props: BulkBarProps): JSX.Element {
  const ui = useUi();
  const count = (): number | undefined =>
    props.count === undefined ? undefined : finiteCount('BulkBar', 'count', props.count);
  const onAllMatching = (event: Event & { currentTarget: HTMLInputElement }): void => {
    props.onAllMatching?.(event.currentTarget.checked);
    event.currentTarget.checked = props.allMatching === true;
  };

  const matchingBox = (matching: SelectionMatching): JSX.Element => (
    <label class={styles['matching']}>
      <input
        type="checkbox"
        name={matching.name}
        value={matching.filter}
        form={props.form}
        checked={props.allMatching === true}
        onChange={props.onAllMatching === undefined ? undefined : onAllMatching}
      />
      {ui.t(UI_KEYS.selectionMatching, {
        count: finiteCount('BulkBar', 'matching.count', matching.count),
      })}
    </label>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of controls, not a form's fieldset
    <div
      class={cx(styles['bar'], props.class)}
      role="group"
      aria-label={ui.t(UI_KEYS.selectionBar)}
      data-count={count() === undefined ? undefined : String(count())}
    >
      {props.count === undefined ? null : (
        // One node while the count lives: a status region replaced on each change says nothing.
        <p class={styles['count']} role="status">
          {ui.t(UI_KEYS.selectionCount, { count: count() ?? 0 })}
        </p>
      )}
      {props.matching === undefined ? null : matchingBox(props.matching)}
      {props.onClear === undefined ? null : (
        <button type="button" class={styles['clear']} onClick={() => props.onClear?.()}>
          {ui.t(UI_KEYS.selectionClear)}
        </button>
      )}
      {props.children === undefined ? null : <div class={styles['actions']}>{props.children}</div>}
    </div>
  );
}
