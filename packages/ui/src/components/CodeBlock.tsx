// A block of code: `<pre><code>` of classed runs, a named scroll region that stays left-to-right
// under `dir="rtl"`, and — with script — a wrap toggle and a copy button. The runs are text nodes,
// so code can never become markup. Languages are passed in, never imported here (axiom 6).

import type { JSX } from 'solid-js';
import { findLanguage, highlight, type Language } from '../content/highlight';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './CodeBlock.module.scss';
import { CopyButton } from './CopyButton';

export interface CodeBlockProps {
  code: string;
  /** The language's name or alias — a fence's info string. Unknown or absent: plain text. */
  language?: string | undefined;
  /** The languages this block may highlight with: `[tsLanguage]`, or `allLanguages` on a server page. */
  languages?: readonly Language[] | undefined;
  /** Already-translated name of the scroll region; defaults to `ui.code.region`. */
  label?: string | undefined;
  /** Start wrapped. The reader can toggle it once script runs. */
  wrap?: boolean | undefined;
  /** `false` hides the copy button. */
  copy?: boolean | undefined;
  class?: string | undefined;
}

export function CodeBlock(props: CodeBlockProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [enhanced, setEnhanced] = rt.createSignal(false);
  rt.createEffect(() => setEnhanced(true));
  const [wrapped, setWrapped] = rt.createSignal(props.wrap === true);
  const tokens = rt.createMemo(() =>
    highlight(props.code, findLanguage(props.language, props.languages)),
  );

  return (
    <div
      class={cx(styles['block'], props.class)}
      data-enhanced={enhanced() ? 'true' : undefined}
      data-wrap={wrapped() ? 'true' : undefined}
    >
      <div class={styles['bar']}>
        <button
          type="button"
          class={styles['toggle']}
          aria-pressed={wrapped() ? 'true' : 'false'}
          onClick={() => setWrapped(!wrapped())}
        >
          {ui.t(UI_KEYS.codeWrap)}
        </button>
        {props.copy === false ? null : <CopyButton value={props.code} size="sm" />}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the <pre> IS the scroll box; a <section> around it would scroll nothing */}
      <pre
        class={styles['pre']}
        dir="ltr"
        tabindex="0"
        role="region"
        aria-label={props.label ?? ui.t(UI_KEYS.codeRegion)}
      >
        <code>
          {tokens().map((token) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              <span class={styles[`tok-${token.kind}`]}>{token.text}</span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
