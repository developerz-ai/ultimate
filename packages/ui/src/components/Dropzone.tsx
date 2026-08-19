// A drop surface that is a real `<label>` around a real, visually-hidden `<input type="file">`.
// That shape is what makes it usable without a mouse: click, Enter and Space already open the
// picker, focus already lands somewhere, and the accessible name is the instruction the label
// renders. A `<div onClick>` with `tabindex` would reimplement all four and get one of them wrong.
// Dragging is the enhancement on top, never the only way in.

import type { JSX } from 'solid-js';
import { ariaBool, useId } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Dropzone.module.scss';
import type { FileSelection } from './file-input-view';
import { adoptDroppedFiles, progressPercent, selectFiles } from './file-input-view';

export interface DropzoneProps {
  /** Already-translated instruction. Required — it is the control's accessible name. */
  label: string;
  /** Already-translated secondary line: the accepted types, the size ceiling. */
  hint?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  /** The `accept` attribute, and the same list a dropped file is partitioned against. */
  accept?: string | undefined;
  multiple?: boolean | undefined;
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
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  /** Every file offered, partitioned into accepted and refused-with-a-reason. */
  onSelect: (selection: FileSelection<File>) => void;
}

export function Dropzone(props: DropzoneProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [over, setOver] = rt.createSignal(false);
  const fallbackId = useId('dropzone');
  let input: HTMLInputElement | undefined;
  const inputId = (): string => props.id ?? fallbackId;
  const percent = (): number => progressPercent(props.progress ?? 0);

  const offer = (files: FileList | null | undefined): void => {
    props.onSelect(selectFiles([...(files ?? [])], props));
  };

  // `dragover` must be cancelled on every tick or the browser refuses the drop and navigates to
  // the file instead — the failure mode where the whole app disappears mid-upload.
  const allowDrop = (event: DragEvent): void => {
    if (props.disabled === true) return;
    event.preventDefault();
    setOver(true);
  };

  return (
    <label
      class={cx(styles['zone'], props.class)}
      for={inputId()}
      data-over={over() ? 'true' : undefined}
      data-disabled={props.disabled === true ? 'true' : undefined}
      onDragEnter={allowDrop}
      onDragOver={allowDrop}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        if (props.disabled === true) return;
        // The input first, then the callback: a drop that only reaches `onSelect` leaves the real
        // control empty, and the form the label sits in submits nothing.
        adoptDroppedFiles(input, event.dataTransfer?.files);
        offer(event.dataTransfer?.files);
      }}
    >
      <span class={styles['label']}>{props.label}</span>
      {props.hint === undefined ? null : <span class={styles['hint']}>{props.hint}</span>}
      <input
        ref={(el: HTMLInputElement) => {
          input = el;
        }}
        class={styles['input']}
        type="file"
        id={inputId()}
        name={props.name}
        accept={props.accept}
        multiple={props.multiple === true}
        required={props.required === true}
        disabled={props.disabled === true}
        aria-describedby={props['aria-describedby']}
        aria-invalid={ariaBool(props['aria-invalid'])}
        onChange={(event) => offer(event.currentTarget.files)}
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
    </label>
  );
}
