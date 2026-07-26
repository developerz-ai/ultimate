// @ultimat3/ui error codes. Every throw carries a stable code, the cause, and
// the exact fix — identical in the terminal, the browser overlay, and `--json`.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const UI_ERROR_CODES = {
  tokenUnknown: 'X_TOKEN_UNKNOWN',
  themeInvalid: 'X_THEME_INVALID',
  runtimeMissing: 'X_UI_RUNTIME_MISSING',
  invalidValue: 'X_UI_INVALID_VALUE',
} as const;

export type UiErrorCode = (typeof UI_ERROR_CODES)[keyof typeof UI_ERROR_CODES];

registerErrorCodes({
  X_TOKEN_UNKNOWN: { title: 'design token role does not exist' },
  X_THEME_INVALID: { title: 'theme is not "light" or "dark"' },
  X_UI_RUNTIME_MISSING: { title: 'a host capability @ultimat3/ui needs is absent' },
  X_UI_INVALID_VALUE: { title: 'a formatting component received an unrenderable value' },
});

export class UiError extends UltimateError {
  override readonly name: string = 'UiError';

  constructor(init: { code: UiErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

/** A component asked for a token role that the SCSS source does not define. */
export function unknownTokenError(kind: string, name: string, known: readonly string[]): UiError {
  return new UiError({
    code: UI_ERROR_CODES.tokenUnknown,
    cause: `unknown ${kind} token "${name}"; known roles: ${known.join(', ')}`,
    fix: `use one of the ${kind} roles above, or add "${name}" to packages/ui/src/tokens/_${kind}s.scss and mirror it in tokens.ts`,
  });
}

/** `data-theme` or a stored preference held something other than light/dark. */
export function invalidThemeError(value: unknown): UiError {
  return new UiError({
    code: UI_ERROR_CODES.themeInvalid,
    cause: `theme must be "light" or "dark", received ${JSON.stringify(value)}`,
    fix: "call setTheme('light') or setTheme('dark'), or clearTheme() to follow the OS",
  });
}

/** A helper reached for a host capability the current environment does not have. */
export function runtimeMissingError(api: string, fix: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.runtimeMissing,
    cause: `@ultimat3/ui needed ${api} but it is not available in this environment`,
    fix,
  });
}

/** A formatting component was handed a value it cannot render. */
export function invalidValueError(kind: string, value: unknown, expected: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `<${kind}> received ${JSON.stringify(value)}, which is not ${expected}`,
    fix: `pass ${expected} — parse or validate the value in the loader, not in the component`,
  });
}
