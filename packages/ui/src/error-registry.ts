// @ultimat3/ui's error TITLES, registered at import. Its own module, and the one `sideEffects`
// names, so `errors.ts` — the constructors — can be declared pure: a barrel re-export of a pure
// module costs a chunk nothing, while a module declared side-effectful is kept by every bundler
// that honours the field the moment the barrel is imported, which under Bun 1.4.2 put core's
// whole error registry (~10 kB) into an island that did nothing but register a runtime.
//
// `errors.ts` imports this file bare, so a chunk that constructs a `UiError` still registers its
// titles first — anchored by use, exactly as `scripts/lib/side-effects-scan.ts` describes.

import { registerErrorCodes } from '@ultimat3/core';

// Unconditional like every other package: every code here is ui's own, and a second package
// claiming one has to throw X_ERROR_CODE_DUPLICATE at import. Taking the process down there is the
// point — the alternative is two packages shipping two meanings for one code, decided by load order.
registerErrorCodes({
  X_TOKEN_UNKNOWN: { title: 'design token role does not exist' },
  X_THEME_INVALID: { title: 'theme is not "light" or "dark"' },
  X_UI_RUNTIME_MISSING: { title: 'a host capability @ultimat3/ui needs is absent' },
  X_UI_INVALID_VALUE: { title: 'a formatting component received an unrenderable value' },
  X_UI_FORM_PATH_INVALID: { title: 'a form control name is not a usable field path' },
  X_UI_CONTRAST_INSUFFICIENT: { title: 'a brand palette pairing does not meet WCAG 2.2 AA' },
  X_UI_QR_CAPACITY: { title: 'text is too long for a QR code this component can draw' },
});
