// @ultimat3/ui error codes. Every throw carries a stable code, the cause, and
// the exact fix — identical in the terminal, the browser overlay, and `--json`.

import { registerErrorCodes, renderCauseValue, UltimateError } from '@ultimat3/core';

export const UI_ERROR_CODES = {
  tokenUnknown: 'X_TOKEN_UNKNOWN',
  themeInvalid: 'X_THEME_INVALID',
  runtimeMissing: 'X_UI_RUNTIME_MISSING',
  invalidValue: 'X_UI_INVALID_VALUE',
} as const;

export type UiErrorCode = (typeof UI_ERROR_CODES)[keyof typeof UI_ERROR_CODES];

// Unconditional like every other package: all four codes are ui's own, and a second package
// claiming one has to throw X_ERROR_CODE_DUPLICATE at import. Taking the process down there is the
// point — the alternative is two packages shipping two meanings for one code, decided by load order.
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

/**
 * A component asked for a token role that the SCSS source does not define. `source` is the
 * partial that declares the scale — defaulted, because most kinds pluralise (`colors`), and
 * named explicitly by the ones that do not (`radius`), so the `fix:` is always a real path.
 */
export function unknownTokenError(
  kind: string,
  name: string,
  known: readonly string[],
  source = `_${kind}s.scss`,
): UiError {
  return new UiError({
    code: UI_ERROR_CODES.tokenUnknown,
    cause: `unknown ${kind} token "${name}"; known roles: ${known.join(', ')}`,
    fix: `use one of the ${kind} roles above, or add "${name}" to packages/ui/src/tokens/${source} and mirror it in tokens.ts`,
  });
}

/**
 * A `defineTheme()` override held something that is not a token value. Strict on purpose: the
 * result is interpolated into a `<style>` element, so a value carrying `;`, `}` or `</style>` is
 * a CSS injection, not a typo.
 */
export function invalidBrandTokenError(
  scope: string,
  name: string,
  value: unknown,
  expected: string,
): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    // The override is the app's own object, so the value is unparsed app data at this point.
    cause: `defineTheme() override ${scope}.${name} is ${renderCauseValue(value)}, which is not ${expected}`,
    fix: `pass ${expected} to defineTheme(), e.g. defineTheme({ colors: { light: { accent: '31 110 178' } } })`,
  });
}

/** `data-theme` or a stored preference held something other than light/dark. */
export function invalidThemeError(value: unknown): UiError {
  return new UiError({
    code: UI_ERROR_CODES.themeInvalid,
    cause: `theme must be "light" or "dark", received ${renderCauseValue(value)}`,
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

/**
 * `<UiProvider>` on a server render. No new code: a reactive runtime is absent, which is exactly
 * what X_UI_RUNTIME_MISSING already names — and a code is stable forever once shipped. The throw
 * is the point. A Provider in an inert tree reaches no descendant (they are walked outside every
 * owner), so rendering the children anyway would drop the locale, zone, currency and translator it
 * was handed while looking like it worked.
 */
export function providerNeedsRuntimeError(): UiError {
  return new UiError({
    code: UI_ERROR_CODES.runtimeMissing,
    cause:
      '<UiProvider> needs a registered Solid runtime; a server render has none, and its values would reach no component',
    fix: 'delete <UiProvider> from the server tree — useUi() already reads the request locale and time zone; keep the provider in the client entry, after setSolidRuntime()',
  });
}

/**
 * `<Icon>` was handed glyph data it refuses to turn into markup. No new code: an unrenderable
 * glyph is exactly what X_UI_INVALID_VALUE already names, and a code is stable forever once shipped
 * — a second one for the same meaning is the thing the catalog exists to prevent.
 */
export function invalidGlyphError(found: string, expected: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `<Icon> glyph carries ${found}, which is not renderable; expected ${expected}`,
    // Command first, the alternative behind a `#`: the line runs verbatim and the shell drops the
    // rest. A `fix:` that opens with `@ultimat3/ui/icons/<name>` is a redirect, not an instruction.
    fix: 'bun run --filter @ultimat3/ui icons   # or import the glyph from @ultimat3/ui/icons/<name>',
  });
}

/** A formatting component was handed a value it cannot render. */
export function invalidValueError(kind: string, value: unknown, expected: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `<${kind}> received ${renderCauseValue(value)}, which is not ${expected}`,
    fix: `pass ${expected} — parse or validate the value in the loader, not in the component`,
  });
}

/**
 * The icon generator was handed upstream data it cannot turn into a glyph module. No new code:
 * malformed data is exactly what X_UI_INVALID_VALUE already names, and a code is stable forever
 * once shipped. It is NOT X_UI_RUNTIME_MISSING, which says a host capability is absent and sends
 * an operator to audit their environment for a fault that is in the file they just downloaded.
 * The generator's environment faults — no network, no biome binary — keep that code.
 */
export function invalidIconDataError(found: string, fix: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `lucide icon data ${found}`,
    fix,
  });
}
