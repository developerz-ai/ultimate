// A diff a person can read with colour off: `+` and `-` gutters, a spoken word per changed row,
// word marks inside a changed pair, line numbers on each side. Unified below `md`, side by side
// from it, by `@container`. Two texts or a unified patch — one parser to rows.

import type { JSX } from 'solid-js';
import type { DiffRow } from '../content/line-diff';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './DiffView.module.scss';
import {
  diffViewRows,
  markedSegments,
  type SidePair,
  sidePairs,
  startsChange,
} from './diff-view-view';

interface DiffViewBase {
  /** Already-translated name of the scroll region; defaults to `ui.diff.region`. */
  label?: string | undefined;
  /** Rows past this fold into one line saying how many. Defaults to 2,000. */
  maxLines?: number | undefined;
  class?: string | undefined;
}

export interface DiffViewTextProps extends DiffViewBase {
  old: string;
  new: string;
  patch?: undefined;
}

export interface DiffViewPatchProps extends DiffViewBase {
  /** A unified patch, as `git diff` writes it. */
  patch: string;
  old?: undefined;
  new?: undefined;
}

export type DiffViewProps = DiffViewTextProps | DiffViewPatchProps;

const sign = (row: DiffRow): string => (row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ');

const isChange = (row: DiffRow | null): boolean => row?.kind === 'add' || row?.kind === 'del';

const pairChanges = (pair: SidePair | undefined): boolean =>
  pair?.kind === 'pair' && (isChange(pair.left) || isChange(pair.right));
const changeStarts = (pairs: readonly SidePair[], index: number): boolean =>
  pairChanges(pairs[index]) && !pairChanges(pairs[index - 1]);

export function DiffView(props: DiffViewProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [enhanced, setEnhanced] = rt.createSignal(false);
  rt.createEffect(() => setEnhanced(true));
  const rows = rt.createMemo(() =>
    diffViewRows({ old: props.old, new: props.new, patch: props.patch, maxLines: props.maxLines }),
  );
  let box: HTMLDivElement | undefined;
  let stop = -1;

  const spoken = (row: DiffRow): JSX.Element =>
    row.kind === 'add' || row.kind === 'del' ? (
      <span class={styles['spoken']}>
        {ui.t(row.kind === 'add' ? UI_KEYS.diffAdded : UI_KEYS.diffRemoved)}
      </span>
    ) : null;

  const text = (row: DiffRow): JSX.Element =>
    'text' in row
      ? markedSegments(row.text, 'marks' in row ? row.marks : undefined).map(([segment, marked]) =>
          marked ? <mark class={styles['word']}>{segment}</mark> : segment,
        )
      : null;

  const whole = (row: DiffRow, span: number): JSX.Element => (
    <tr class={styles[row.kind]}>
      <td colspan={span}>
        {row.kind === 'fold'
          ? ui.t(UI_KEYS.diffFolded, { count: row.count })
          : 'text' in row
            ? row.text
            : null}
      </td>
    </tr>
  );

  const half = (row: DiffRow | null, side: 'old' | 'new'): JSX.Element[] => [
    <td class={styles['num']}>
      {row !== null && (row.kind === 'add' || row.kind === 'del' || row.kind === 'context')
        ? row[side]
        : null}
    </td>,
    <td class={styles['sign']} aria-hidden="true">
      {row === null ? '' : sign(row)}
    </td>,
    <td class={cx(styles['text'], row !== null && styles[row.kind])}>
      {row === null ? null : spoken(row)}
      {row === null ? null : text(row)}
    </td>,
  ];

  const next = (): void => {
    const table = [...(box?.querySelectorAll<HTMLElement>('table') ?? [])].find(
      (el) => el.offsetParent !== null,
    );
    const starts = [...(table?.querySelectorAll<HTMLElement>('[data-change="start"]') ?? [])];
    if (starts.length === 0) return;
    stop = (stop + 1) % starts.length;
    starts[stop]?.scrollIntoView({ block: 'center' });
  };

  return (
    <div class={cx(styles['diff'], props.class)} data-enhanced={enhanced() ? 'true' : undefined}>
      <div class={styles['bar']}>
        <button type="button" class={styles['next']} onClick={next}>
          {ui.t(UI_KEYS.diffNext)}
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the scroll box holds two tables, one shown per width */}
      <div
        class={styles['scroll']}
        tabindex="0"
        role="region"
        aria-label={props.label ?? ui.t(UI_KEYS.diffRegion)}
        dir="ltr"
        ref={(el: HTMLDivElement) => {
          box = el;
        }}
      >
        <table class={styles['unified']}>
          <tbody>
            {rows().map((row, index) =>
              row.kind === 'add' || row.kind === 'del' || row.kind === 'context' ? (
                <tr
                  class={styles['row']}
                  data-change={startsChange(rows(), index) ? 'start' : undefined}
                >
                  <td class={styles['num']}>{row.old}</td>
                  {half(row, 'new')}
                </tr>
              ) : (
                whole(row, 4)
              ),
            )}
          </tbody>
        </table>
        <table class={styles['split']}>
          <tbody>
            {sidePairs(rows()).map((pair, index, pairs) =>
              pair.kind === 'whole' ? (
                whole(pair.row, 6)
              ) : (
                <tr
                  class={styles['row']}
                  data-change={changeStarts(pairs, index) ? 'start' : undefined}
                >
                  {half(pair.left, 'old')}
                  {half(pair.right, 'new')}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
