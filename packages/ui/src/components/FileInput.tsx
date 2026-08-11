// A file picker that keeps the platform control and dresses it. The native button and the
// browser's own "no file chosen" summary are already localised, focusable and keyboard-driven,
// so replacing them with a div buys nothing and costs an accessible name. What the platform has
// no opinion about is added here: a determinate progress bar, and a partition of what it refused.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './FileInput.module.scss';
import type { FileSelection } from './file-input-view';
import { progressPercent, selectFiles } from './file-input-view';
import type { Size } from './variants';

export interface FileInputProps {
  id?: string | undefined;
  name?: string | undefined;
  /** The `accept` attribute, and the same list the refusal partition is computed against. */
  accept?: string | undefined;
  multiple?: boolean | undefined;
  size?: Size | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Client-side ceiling. The server enforces its own; this only spares a doomed transfer. */
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  /** 0..1 while an upload runs. Absent renders no bar at all — never one stuck at zero. */
  progress?: number | undefined;
  /** Already-translated accessible name for the progress bar. */
  progressLabel?: string | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  /** Every chosen file, partitioned into accepted and refused-with-a-reason. */
  onSelect?: ((selection: FileSelection<File>) => void) | undefined;
  onBlur?: JSX.EventHandlerUnion<HTMLInputElement, FocusEvent> | undefined;
}

export function FileInput(props: FileInputProps): JSX.Element {
  const ui = useUi();
  const percent = (): number => progressPercent(props.progress ?? 0);

  return (
    <span
      class={cx(styles['wrap'], styles[`size-${props.size ?? 'md'}`], props.class)}
      data-disabled={props.disabled === true ? 'true' : undefined}
    >
      <input
        class={styles['input']}
        type="file"
        id={props.id}
        name={props.name}
        accept={props.accept}
        multiple={props.multiple === true}
        required={props.required === true}
        disabled={props.disabled === true}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
        onBlur={props.onBlur}
        onChange={(event) => {
          props.onSelect?.(selectFiles([...(event.currentTarget.files ?? [])], props));
        }}
      />
      {props.progress === undefined ? null : (
        <span
          class={styles['progress']}
          role="progressbar"
          aria-label={props.progressLabel ?? ui.t(UI_KEYS.loading)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()}
          style={{ '--file-progress': `${percent()}%` }}
        >
          <span class={styles['bar']} />
        </span>
      )}
    </span>
  );
}
