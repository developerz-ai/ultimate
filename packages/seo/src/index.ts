// The public surface of @ultimat3/seo. Explicit named exports only.

export type { BudgetMeasurement, BudgetMetric, BudgetReport, BudgetViolation } from './budgets';
export { assertBudgets, BUDGET_UNITS, checkBudgets, DEFAULT_BUDGET, parseBytes } from './budgets';
export type { SeoErrorCode, SeoErrorInit } from './errors';
export {
  budgetExceeded,
  canonicalMismatch,
  duplicateMeta,
  ldInvalid,
  metaMissing,
  metaTooLong,
  notImplementedDriver,
  SEO_ERROR_CODES,
  SeoError,
  sitemapTooLarge,
} from './errors';
export type {
  ImageInput,
  ImageSourceSet,
  ImageTransformDriver,
  ModernFormat,
  ResponsiveImage,
  ResponsiveImageOptions,
  TransformedImage,
  TransformRequest,
} from './images';
export {
  bunImageDriver,
  DEFAULT_WIDTHS,
  extensionOf,
  FORMAT_ORDER,
  inlineBlur,
  MIME_TYPES,
  renderPicture,
  responsiveImage,
  srcsetFor,
  usableWidths,
} from './images';
export type {
  ArticleAuthor,
  ArticleAuthorOrganization,
  ArticleAuthorPerson,
  ArticleInput,
  BreadcrumbInput,
  EventInput,
  FaqInput,
  JsonLd,
  OfferInput,
  OrganizationInput,
  PersonInput,
  ProductInput,
  SoftwareApplicationInput,
  WebSiteInput,
} from './ld';
export {
  Article,
  BreadcrumbList,
  Event,
  FAQPage,
  LD_CONTEXT,
  ld,
  Organization,
  Person,
  Product,
  renderLd,
  SoftwareApplication,
  WebSite,
} from './ld';
export type {
  AlternateLocale,
  HeadTag,
  OpenGraph,
  OpenGraphImage,
  RenderMetaOptions,
  RobotsDirectives,
  RouteMeta,
  ThemeColor,
  TwitterCard,
} from './meta';
export {
  applyTitleTemplate,
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  hreflangSet,
  renderHeadTags,
  renderMeta,
  robotsContent,
  TITLE_MAX_LENGTH,
} from './meta';
export type { RobotsConfig, RobotsGroup, SeoEnvironment } from './robots';
export { buildRobots, isIndexable, resolveEnvironment } from './robots';
export type { ChangeFreq, RenderMode, RouteBudget, RouteRecord, Surface } from './routes';
export { expandRoute, indexableRoutes, isDynamic } from './routes';
export type { Feed, FeedAuthor, FeedChannel, FeedItem } from './rss';
export { buildFeed } from './rss';
export type {
  BuildSitemapOptions,
  SitemapAlternate,
  SitemapFile,
  SitemapResult,
  SitemapUrl,
} from './sitemap';
export {
  buildSitemap,
  chunk,
  SITEMAP_INDEX_MAX_FILES,
  SITEMAP_MAX_URLS,
  sitemapUrls,
} from './sitemap';
export type { MetaIssue, MetaValidationReport, ValidateMetaOptions } from './validate';
export { assertMeta, validateMeta } from './validate';

export { absoluteUrl, escapeAttribute, escapeXml } from './xml';
