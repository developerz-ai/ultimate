// Copies one string to the clipboard and says so — the control beside a short URL, an id, a
// command. Server-rendered as a real button; the clipboard write and the 1.6 s "copied" state are
// additive client behaviour, so with scripting off the button is there and does nothing, which
// is what a clipboard needs a script for anyway.

import type { JSX } from 'solid-js';
import { announce } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { iconCheck } from '../icons/glyphs/check';
import { iconCopy } from '../icons/glyphs/copy';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './CopyButton.module.scss';
import { writeToClipboard } from './copy-write';
import { Icon } from './Icon';
import type { Size } from './variants';

/** How long the check mark stays before the copy icon returns. */
export const COPIED_MS = 1600;

export interface CopyButtonProps {
  /** What lands on the clipboard. */
  value: string;
  /** The accessible name; defaults to the catalog's `ui.copy`. */
  label?: string | undefined;
  /** Announced to assistive tech once the write succeeds; defaults to `ui.copied`. */
  copiedLabel?: string | undefined;
  size?: Size | undefined;
  class?: string | undefined;
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [copied, setCopied] = rt.createSignal(false);
  const label = (): string => props.label ?? ui.t(UI_KEYS.copy);
  const copiedLabel = (): string => props.copiedLabel ?? ui.t(UI_KEYS.copied);

  let reset: ReturnType<typeof setTimeout> | undefined;
  // The "copied" timer does not outlive the button: firing a setter on an unmounted component is
  // a write into a disposed owner.
  rt.onCleanup(() => clearTimeout(reset));

  const onClick = async (): Promise<void> => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    // "Copied" only on a write that RESOLVED: no clipboard used to show the check mark anyway, and
    // a refused write escaped as an unhandled rejection through the `void` below.
    if (!(await writeToClipboard(props.value, clipboard))) return;
    setCopied(true);
    clearTimeout(reset);
    reset = setTimeout(() => setCopied(false), COPIED_MS);
    // `announce` needs a document that can find its live region.
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      announce(copiedLabel());
    }
  };

  return (
    <button
      type="button"
      class={cx(styles['copy'], styles[`size-${props.size ?? 'md'}`], props.class)}
      title={label()}
      aria-label={copied() ? copiedLabel() : label()}
      data-copied={copied() ? 'true' : undefined}
      onClick={() => void onClick()}
    >
      <Icon glyph={copied() ? iconCheck : iconCopy} size="sm" />
    </button>
  );
}
