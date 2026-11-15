// The names of the guards the framework ships, as a leaf: no template, no I/O. The serving roles'
// graph may hold it (`x.manifest.json` lists a built-in's code), which `templates/` never may —
// so `templates/scaffold-guards.ts` keys its `SHIPPED` table by this list, and tsc holds them equal.

export const SHIPPED_GUARD_NAMES = [
  'animated-layout-property',
  'bare-error',
  'error-declared',
  'focus-visible',
  'image-dimensions',
  'island-mount-clears',
  'island-without-states',
  'native-confirm',
  'raw-breakpoint',
  'raw-colour',
  'raw-fetch',
  'raw-interval',
  'raw-length',
  'raw-motion',
  'raw-shadow',
  'raw-z-index',
  'repo-await-in-loop',
  'repo-raw-sql',
  'repo-unbounded',
  'runtime-pin',
  'semantic-interactive',
  'unbounded-fanout',
  'undeclared-custom-property',
  'undefined-style-class',
  'untranslated-string',
  'unzoned-date',
] as const;

export type ShippedGuardName = (typeof SHIPPED_GUARD_NAMES)[number];

/** `raw-fetch` → `X_RAW_FETCH`: `templates/guard.ts`' `guardCode` over a name already kebab. */
export const shippedGuardCode = (name: ShippedGuardName): string =>
  `X_${name.toUpperCase().replaceAll('-', '_')}`;
