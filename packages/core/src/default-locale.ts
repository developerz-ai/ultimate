// The framework's default locale and time zone — the ONE declaration, in a leaf of its own:
// `@ultimat3/i18n`'s translator reads the locale, and an island's translator
// (`@ultimat3/i18n/subset`) must not carry the request context (`context.ts`, its async storage)
// to read a constant.

/** `@ultimat3/i18n` imports it rather than restating it: a second `'en'` there could drift. */
export const DEFAULT_LOCALE = 'en';
export const DEFAULT_TIME_ZONE = 'UTC';
