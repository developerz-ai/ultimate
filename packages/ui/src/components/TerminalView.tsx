// One styled stream of terminal output on `VirtualList`: SGR colours as roles, every other escape
// dropped, wrapped by default, left-to-right under `dir="rtl"`. A focusable region where Home and
// End jump. Output only: keystrokes are an app's island over its own transport.

import { finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { type AnsiLine, parseAnsi } from '../content/ansi';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './TerminalView.module.scss';
import { VirtualList } from './VirtualList';

export interface TerminalViewProps {
  /** Raw output, escapes and all. */
  text: string;
  /** Already-translated name of the region; defaults to `ui.code.terminal`. */
  label?: string | undefined;
  /** Lines tall, before it scrolls. Defaults to 24, a terminal's own. */
  rows?: number | undefined;
  /** Follow the end as output arrives. Defaults to true. */
  follow?: boolean | undefined;
  class?: string | undefined;
}

interface Row {
  readonly id: string;
  readonly runs: AnsiLine;
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const rows = rt.createMemo((): readonly Row[] =>
    parseAnsi(props.text).map((runs, index) => ({ id: String(index), runs })),
  );
  let region: HTMLDivElement | undefined;
  const label = (): string => props.label ?? ui.t(UI_KEYS.codeTerminal);

  const line = (row: Row): JSX.Element => (
    <span class={styles['line']}>
      {row.runs.length === 0
        ? ' '
        : row.runs.map((run) => (
            <span
              class={cx(
                run.fg !== undefined && styles[`fg-${run.fg}`],
                run.bold === true && styles['bold'],
                run.dim === true && styles['dim'],
                run.italic === true && styles['italic'],
                run.underline === true && styles['underline'],
              )}
            >
              {run.text}
            </span>
          ))}
    </span>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: the focusable region whose Home and End move the list inside it
    <div
      class={cx(styles['terminal'], props.class)}
      tabindex="0"
      role="region"
      aria-label={label()}
      dir="ltr"
      style={{
        '--terminal-rows': String(finiteCount('TerminalView', 'rows', props.rows ?? 24, 1)),
      }}
      ref={(el: HTMLDivElement) => {
        region = el;
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'Home' && event.key !== 'End') return;
        // VirtualList's scroll box is the parent of its list.
        const box = region?.querySelector('ul')?.parentElement;
        if (box === null || box === undefined) return;
        event.preventDefault();
        box.scrollTop = event.key === 'Home' ? 0 : box.scrollHeight;
      }}
    >
      {/* The box is this component's: its height is fixed here, whatever order the sheets load in. */}
      <div class={styles['box']}>
        <VirtualList
          items={rows()}
          itemKey={(row: Row) => row.id}
          renderItem={line}
          follow={props.follow !== false}
          label={label()}
          class={styles['frame']}
        />
      </div>
    </div>
  );
}
