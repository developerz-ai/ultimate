// The four ways `x shot`'s raw-CDP page refuses a verb. A browser that is
// missing, dies or never answers is `@ultimat3/testing`'s `X_CDP_*` — the wire is the same one the
// e2e driver runs on. These four are what only a shot can be wrong about: which host it may open,
// which element it was pointed at, and which key it was asked to press. Their codes and titles are
// registered with every other CLI code, in `error-codes.ts` — never a second registration here.
import { renderCauseValue, UltimateError } from '@ultimat3/core';

/** A navigation to a host the run did not allow. Refused before a byte leaves. */
export class ShotHostRefusedError extends UltimateError {
  constructor(input: { readonly url: string; readonly allowHosts: readonly string[] }) {
    super({
      code: 'X_SHOT_HOST_REFUSED',
      cause: `${renderCauseValue(input.url)} is on no host in the allow list ${renderCauseValue(input.allowHosts)}`,
      fix: 'x shot /route --allow-hosts cdn.example.com   # name every extra host the page needs; the app host is always allowed',
      meta: { allowHosts: [...input.allowHosts] },
    });
  }
}

/** Nothing ever matched: the markup changed, or the selector was never right. */
export class ShotElementMissingError extends UltimateError {
  constructor(input: {
    readonly selector: string;
    readonly url: string;
    readonly timeoutMs: number;
  }) {
    super({
      code: 'X_SHOT_ELEMENT_MISSING',
      cause: `nothing on ${renderCauseValue(input.url)} matched ${renderCauseValue(input.selector)} within ${String(input.timeoutMs)}ms`,
      fix: 'run ui.inspect on the route first and copy a selector it reports with count >= 1',
      meta: { selector: input.selector },
    });
  }
}

/** It matched, and something kept it from being acted on: hidden, disabled, covered, moving. */
export class ShotElementUnreadyError extends UltimateError {
  constructor(input: {
    readonly selector: string;
    readonly problem: string;
    readonly timeoutMs: number;
  }) {
    super({
      code: 'X_SHOT_ELEMENT_UNREADY',
      cause: `${renderCauseValue(input.selector)} was still ${renderCauseValue(input.problem)} after ${String(input.timeoutMs)}ms`,
      fix: 'run ui.inspect with the selector and "a11y": true to see what covers or disables it, then act on that element first',
      meta: { selector: input.selector, problem: input.problem },
    });
  }
}

/** A chord the grammar refuses — the caller's own literal, so the refusal is terminal. */
export class ShotKeyInvalidError extends UltimateError {
  constructor(input: { readonly chord: string; readonly reason: string }) {
    super({
      code: 'X_SHOT_KEY_INVALID',
      cause: `the key chord ${renderCauseValue(input.chord)} ${input.reason}`,
      fix: "spell it as modifiers then one key, in the browser's names: 'Meta+K', 'Control+Enter', 'Shift+Tab', 'Escape'",
      meta: { chord: input.chord },
    });
  }
}
