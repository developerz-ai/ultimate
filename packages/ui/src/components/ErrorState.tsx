// Renders an UltimateError with the same three strings the terminal prints:
// code, cause, fix. Identical text in the CLI, the overlay, and `--json` is the
// whole point of the error contract — this component must not paraphrase.

import {
  describeErrorCode,
  isUltimateError,
  renderCauseValue,
  renderFixShellArg,
  stringField,
} from '@ultimat3/core';
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
  // Every field through `stringField`, never `error.code`: a getter or a `Proxy` trap on the value
  // throws during the READ, and this is the component that renders an error — its throw replaced
  // the screen reporting one with a blank tree. A field that will not read falls back to the
  // registry's answer for the code, so the code itself survives whatever else is unreadable.
  const code = isUltimateError(error) ? stringField(error, 'code') : undefined;
  if (code !== undefined) {
    const known = describeErrorCode(code);
    return {
      code,
      // The error's own `title` first: a remote code this realm never registered carries the
      // server's title there (`remoteTitle`), and the registry would only humanise the code.
      title: stringField(error, 'title') ?? known.title,
      cause: stringField(error, 'cause') ?? renderCauseValue(error),
      // Screened: the code came off a value the app (or a wire) built, and a fix is pasted into a
      // shell. The placeholder is single-quoted so it is inert there, never a `<` redirection.
      fix:
        stringField(error, 'fix') ??
        `x errors explain ${renderFixShellArg(code, "'<the code above>'")}`,
      docs: stringField(error, 'docs') ?? known.docs,
    };
  }
  // `props.error` is any thrown value, so `String()` ran the app's own `toString`. Laundering it
  // through a local `message` is exactly what `scripts/error-render.ts` says it cannot see, which
  // is why this one shipped.
  const message = thrownMessage(error) ?? renderCauseValue(error);
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

/** An `Error`'s own message, or `undefined` when it is not one or will not be read. */
function thrownMessage(error: unknown): string | undefined {
  try {
    // `instanceof` runs a `Proxy`'s `getPrototypeOf` trap, so the test is inside the guard too.
    return error instanceof Error ? stringField(error, 'message') : undefined;
  } catch {
    return undefined;
  }
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
