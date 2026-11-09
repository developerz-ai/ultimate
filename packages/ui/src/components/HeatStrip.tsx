// Rows of status cells — a check per five minutes, a service per row — as HTML, not a chart: each
// cell is one element named by its whole reading, shaped by its tone, and a link when it has a
// page. Arrow keys never: a linked cell is a tab stop like any link, an unlinked one is none.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './HeatStrip.module.scss';
import type { HeatCellView, HeatRow } from './heat-strip-view';
import { heatCells } from './heat-strip-view';

export interface HeatStripProps {
  /** The strip's name, already translated: its caption. */
  label: string;
  /** One row per thing watched; cells oldest first. */
  rows: readonly HeatRow[];
  /** Show the caption. Default off — it names the figure for assistive tech either way. */
  showCaption?: boolean | undefined;
  class?: string | undefined;
}

export function HeatStrip(props: HeatStripProps): JSX.Element {
  return (
    <figure class={cx(styles['strip'], props.class)}>
      <figcaption class={props.showCaption === true ? styles['caption'] : styles['hidden']}>
        {props.label}
      </figcaption>
      {props.rows.map((row) => (
        <div class={styles['row']}>
          <span class={styles['name']}>{row.label}</span>
          <ol class={styles['cells']} aria-label={row.label}>
            {heatCells(row).map((cell) => (
              <li class={styles['slot']}>{cellNode(cell)}</li>
            ))}
          </ol>
        </div>
      ))}
    </figure>
  );
}

function cellNode(cell: HeatCellView): JSX.Element {
  return cell.href === undefined ? (
    // One value as a picture: `img` names it and claims nothing more, and is no tab stop.
    <span
      class={styles['cell']}
      role="img"
      aria-label={cell.name}
      title={cell.name}
      data-tone={cell.tone}
      data-shape={cell.shape}
    />
  ) : (
    <a
      class={cx(styles['cell'], styles['linked'])}
      href={cell.href}
      title={cell.name}
      data-tone={cell.tone}
      data-shape={cell.shape}
    >
      {/* The link's name is its content — the whole reading — read and never seen. */}
      <span class={styles['hidden']}>{cell.name}</span>
    </a>
  );
}
