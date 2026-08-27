/** Public surface of @ultimat3/i18n. Explicit exports only. */

// Anchored on purpose, and NOT by the `sideEffects` array: Bun reads any array as `false` and drops
// the module regardless (oven-sh/bun#40650). `registerBaseCatalog` here fills the catalog `t()`
// falls back to, and `t()` never imports this module — so without the bare import every framework
// string renders as its ⟦key⟧ placeholder. `SIDE_EFFECTS_ANCHORS` carries the argument and
// `bun run side-effects` enforces it.
import './framework';

export {
  type Catalog,
  catalogKeys,
  flattenCatalog,
  loadCatalog,
  mergeCatalogs,
  missingFrom,
  type NestedCatalog,
  nestCatalog,
  parseNestedCatalog,
} from './catalog';
export {
  catalogFor,
  configureLocales,
  currentDirection,
  currentLocale,
  LOCALE_COOKIE,
  type LocaleConfig,
  type LocaleResolution,
  type LocaleSourceName,
  type LocaleSources,
  localeConfig,
  localeCookieOf,
  registerBaseCatalog,
  registerCatalog,
  registeredLocales,
  resetCatalogs,
  resetLocaleConfig,
  resolveLocale,
  t,
  translatorFor,
  useI18n,
} from './context';
export {
  type CatalogSet,
  type CatalogSources,
  type DefineCatalogsInput,
  defineCatalogs,
} from './define-catalogs';
export {
  catalogInvalid,
  catalogMissingKeys,
  catalogsNeverRegistered,
  catalogUnregistered,
  I18N_ERROR_CODES,
  I18N_ERROR_TITLES,
  I18nError,
  type I18nErrorCode,
  localeUnsupported,
} from './errors';
export {
  type AuditInput,
  assertCatalogsComplete,
  auditCatalogs,
  type DynamicUsage,
  type Extraction,
  type ExtractOptions,
  type ExtractReport,
  extractFromFiles,
  extractKeys,
  type KeyUsage,
  type LocaleAudit,
  mergeExtractions,
} from './extract';
export { FRAMEWORK_CATALOG, FRAMEWORK_CATALOG_LOCALE } from './framework';
export {
  type InterpolationValue,
  type InterpolationVars,
  interpolate,
  PLURAL_CATEGORIES,
  placeholdersOf,
  pluralCategory,
  pluralKeyCandidates,
  pluralVariantsOf,
  selectPluralKey,
} from './interpolate';
export {
  assertSupportedLocale,
  DEFAULT_LOCALE,
  type Direction,
  directionOf,
  isRtl,
  isSupportedLocale,
  type LanguageRange,
  type Locale,
  negotiateLocale,
  normalizeLocale,
  parseAcceptLanguage,
  SUPPORTED_LOCALES,
} from './locales';
export {
  assertCatalogsRegistered,
  type CatalogRegistrationGap,
  catalogRegistrationGaps,
} from './registration';
export {
  createTranslator,
  isMiss,
  type TranslateVars,
  type TranslationKey,
  type Translator,
} from './translator';
