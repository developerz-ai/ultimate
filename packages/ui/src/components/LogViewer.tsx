// Structured log rows on `VirtualList`: a 100,000-line run mounts a screenful, follows the end
// while the reader is there, and keeps only the newest `cap` lines. With script, a text filter, a
// level floor and a follow toggle; without it, every line given is in the document.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { DateTime } from './DateTime';
import { Link } from './Link';
import styles from './LogViewer.module.scss';
import { LOG_VIEWER_LEVELS, type LogLine, type LogViewerLevel, logWindow } from './log-viewer-view';
import { VirtualList } from './VirtualList';

export interface LogViewerProps {
  lines: readonly LogLine[];
  /** Already-translated name of the log; defaults to `ui.log.region`. */
  label?: string | undefined;
  /** Start following the end. Defaults to true; the reader can turn it off. */
  follow?: boolean | undefined;
  /** The newest lines kept. Defaults to 10,000. */
  cap?: number | undefined;
  class?: string | undefined;
}

const isLevel = (value: string): value is LogViewerLevel =>
  (LOG_VIEWER_LEVELS as readonly string[]).includes(value);

export function LogViewer(props: LogViewerProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [enhanced, setEnhanced] = rt.createSignal(false);
  rt.createEffect(() => setEnhanced(true));
  const [query, setQuery] = rt.createSignal('');
  const [minimum, setMinimum] = rt.createSignal<LogViewerLevel | undefined>(undefined);
  const [follow, setFollow] = rt.createSignal(props.follow !== false);
  const shown = rt.createMemo(() =>
    logWindow(props.lines, {
      query: query(),
      minimum: minimum(),
      cap: props.cap,
      locale: ui.locale,
    }),
  );
  const label = (): string => props.label ?? ui.t(UI_KEYS.logRegion);

  const row = (line: LogLine): JSX.Element => (
    <div class={styles['line']} data-level={line.level}>
      {line.at === undefined ? (
        <span />
      ) : (
        <DateTime
          value={line.at}
          timeZone={ui.timeZone}
          timeStyle="medium"
          class={styles['time']}
        />
      )}
      <span class={styles['level']}>{line.level ?? ''}</span>
      <span class={styles['text']}>
        {line.href === undefined ? line.text : <Link href={line.href}>{line.text}</Link>}
      </span>
    </div>
  );

  return (
    <section
      class={cx(styles['log'], props.class)}
      aria-label={label()}
      data-enhanced={enhanced() ? 'true' : undefined}
    >
      <div class={styles['bar']}>
        <input
          type="search"
          class={styles['filter']}
          aria-label={ui.t(UI_KEYS.logFilter)}
          placeholder={ui.t(UI_KEYS.logFilter)}
          value={query()}
          onInput={(event: InputEvent) => setQuery((event.currentTarget as HTMLInputElement).value)}
        />
        <select
          class={styles['levels']}
          aria-label={ui.t(UI_KEYS.logLevel)}
          onChange={(event: Event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            setMinimum(isLevel(value) ? value : undefined);
          }}
        >
          <option value="" selected={minimum() === undefined}>
            {ui.t(UI_KEYS.logAll)}
          </option>
          {LOG_VIEWER_LEVELS.map((level) => (
            <option value={level} selected={minimum() === level}>
              {level}
            </option>
          ))}
        </select>
        <button
          type="button"
          class={styles['follow']}
          aria-pressed={follow() ? 'true' : 'false'}
          onClick={() => setFollow(!follow())}
        >
          {ui.t(UI_KEYS.logFollow)}
        </button>
      </div>
      {shown().dropped > 0 ? (
        <p class={styles['capped']}>{ui.t(UI_KEYS.logCapped, { count: shown().lines.length })}</p>
      ) : null}
      {/* The box is this component's: its height is fixed here, whatever order the sheets load in. */}
      <div class={styles['box']}>
        <VirtualList
          items={shown().lines}
          itemKey={(line: LogLine) => line.id}
          renderItem={row}
          follow={follow()}
          label={label()}
        />
      </div>
    </section>
  );
}
