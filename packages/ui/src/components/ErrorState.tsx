// Renders an UltimateError with the same three strings the terminal prints:
// code, cause, fix. Identical text in the CLI, the overlay, and `--json` is the
// whole point of the error contract — this component must not paraphrase.

import { describeErrorCode, isUltimateError, renderCauseValue } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { Button } from './Button';
import styles from './ErrorState.module.scss';

export interface ErrorStateProps {
  /** An UltimateError, or any thrown value; unknown values get X_INTERNAL text. */
  error: unknown;
  onRetry?: (() => void) | undefined;
  /** Already-translated; falls back to the ui.* catalog keys. */
  retryLabel?: string | undefined;
  /** Link the code to its docs page. On by default. */
  showDocs?: boolean | undefined;
  class?: string | undefined;
}

interface ErrorParts {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
}

export function errorParts(error: unknown): ErrorParts {
  if (isUltimateError(error)) {
    return {
      code: error.code,
      title: error.title,
      cause: error.cause,
      fix: error.fix,
      docs: error.docs,
    };
  }
  // `props.error` is any thrown value, so `String()` ran the app's own `toString` — and this is the
  // component that RENDERS an error, so its throw replaced the screen that was reporting one with a
  // blank tree. Laundering it through a local `message` is exactly what `scripts/error-render.ts`
  // says it cannot see, which is why this one shipped.
  const message = error instanceof Error ? error.message : renderCauseValue(error);
  // Title and docs come from core's registry, never a hand-copy: this screen must read exactly
  // as `x errors explain X_INTERNAL` does, and there is one docs URL for every code.
  const described = describeErrorCode('X_INTERNAL');
  return {
    code: 'X_INTERNAL',
    title: described.title,
    cause: message,
    // No command can name a throw site the framework never saw typed. The one repair is at the
    // throw itself, which is also the repo's own rule — never a bare Error — so the fix says that
    // rather than sending the reader to a log that holds the same message this screen already has.
    fix: 'throw an UltimateError subclass where this failed — new UltimateError({ code, cause, fix }) — so this screen renders that code and its fix instead of X_INTERNAL',
    docs: described.docs,
  };
}

export function ErrorState(props: ErrorStateProps): JSX.Element {
  const ui = useUi();
  const parts = (): ErrorParts => errorParts(props.error);

  return (
    <div class={cx(styles['error'], props.class)} role="alert">
      <p class={styles['head']}>
        {/* The heading is the ONE string here the design system owns, so it is translated;
            `parts()` carries the error's own three, which are English by construction — a code's
            registry title, its cause and its fix are the same text the terminal prints. */}
        <span class={styles['title']}>{ui.t(UI_KEYS.error)}</span>
      </p>
      <dl class={styles['detail']}>
        {/* A bare code with no label reads as noise to anyone who is not the author of the throw. */}
        <dt>{ui.t(UI_KEYS.errorCode)}</dt>
        <dd>
          <code class={styles['code']}>{parts().code}</code> {parts().title}
        </dd>
        <dt>{ui.t(UI_KEYS.errorCause)}</dt>
        <dd>{parts().cause}</dd>
        <dt>{ui.t(UI_KEYS.errorFix)}</dt>
        <dd>
          <code class={styles['fix']}>{parts().fix}</code>
        </dd>
      </dl>
      <div class={styles['actions']}>
        {props.onRetry === undefined ? null : (
          <Button size="sm" variant="secondary" tone="danger" onClick={() => props.onRetry?.()}>
            {props.retryLabel ?? ui.t(UI_KEYS.retry)}
          </Button>
        )}
        {props.showDocs === false ? null : (
          <a class={styles['docs']} href={parts().docs} target="_blank" rel="noopener noreferrer">
            {parts().code}
          </a>
        )}
      </div>
    </div>
  );
}
