// Renders an UltimateError with the same three strings the terminal prints:
// code, cause, fix. Identical text in the CLI, the overlay, and `--json` is the
// whole point of the error contract — this component must not paraphrase.

import { isUltimateError } from '@ultimat3/core';
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
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'X_INTERNAL',
    title: 'unexpected internal framework error',
    cause: message,
    fix: 'x logs --json | tail -50',
    docs: 'https://ultimate.dev/errors/X_INTERNAL',
  };
}

export function ErrorState(props: ErrorStateProps): JSX.Element {
  const ui = useUi();
  const parts = (): ErrorParts => errorParts(props.error);

  return (
    <div class={cx(styles['error'], props.class)} role="alert">
      <p class={styles['head']}>
        <code class={styles['code']}>{parts().code}</code>
        <span class={styles['title']}>{parts().title}</span>
      </p>
      <dl class={styles['detail']}>
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
