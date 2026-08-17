/** Public surface of @ultimat3/i18n. Explicit exports only. */

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
  registerCatalog,
  registeredLocales,
  resetCatalogs,
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
export {
  FRAMEWORK_CATALOG,
  FRAMEWORK_CATALOG_LOCALE,
  registerFrameworkCatalog,
} from './framework';
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
  createTranslator,
  isMiss,
  type TranslateVars,
  type TranslationKey,
  type Translator,
} from './translator';
