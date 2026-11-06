// The page's keyboard legend: a `Dialog` listing every row every island registered, opened by `?`
// — itself a row of the same table, so the sheet lists exactly the bindings that work. Hidden with
// scripting off (a shortcut needs a listener) and never offered where nothing hovers: a phone.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { hotkeyKeycaps } from '../hotkeys-view';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { useHotkeyRows, useHotkeys } from '../use-hotkeys';
import { Dialog } from './Dialog';
import { Kbd } from './Kbd';
import styles from './ShortcutSheet.module.scss';

export interface ShortcutSheetProps {
  /** The dialog's title and the `?` row's legend. Defaults to the translated `ui.shortcuts`. */
  title?: string | undefined;
  class?: string | undefined;
}

/** A touch-only device has no keyboard to read the legend for. */
const offered = (): boolean =>
  typeof matchMedia !== 'function' || !matchMedia('(hover: none)').matches;

export function ShortcutSheet(props: ShortcutSheetProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [open, setOpen] = rt.createSignal(false);
  const title = (): string => props.title ?? ui.t(UI_KEYS.shortcuts);
  const table = useHotkeyRows();

  useHotkeys([
    {
      keys: ['?'],
      label: title(),
      run: () => {
        if (offered()) setOpen(!open());
      },
    },
  ]);

  return (
    <Dialog open={open()} title={title()} size="sm" onClose={() => setOpen(false)}>
      <dl class={cx(styles['sheet'], props.class)}>
        {table().rows.map((row) => (
          <div class={styles['row']}>
            <dt class={styles['label']}>{row.label}</dt>
            <dd class={styles['keys']}>
              {row.keys.map((binding) => (
                <span class={styles['binding']}>
                  {hotkeyKeycaps(binding, table().mac).map((step) => (
                    <span class={styles['step']}>
                      {step.map((cap) => (
                        <Kbd>{cap}</Kbd>
                      ))}
                    </span>
                  ))}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
