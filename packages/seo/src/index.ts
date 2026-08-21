// The public surface of @ultimat3/seo. Explicit named exports only.

export type { RenderMode } from '@ultimat3/core';
export type { SeoErrorCode, SeoErrorInit } from './errors';
export {
  canonicalMismatch,
  duplicateMeta,
  imageQueryInvalid,
  ldInvalid,
  metaMissing,
  metaTooLong,
  notImplementedDriver,
  SEO_ERROR_CODES,
  SeoError,
  sitemapTooLarge,
} from './errors';
export type {
  BuiltinImageDriverOptions,
  ImageTransformDriver,
  TransformedImage,
  TransformRequest,
} from './image-driver';
export { builtinImageDriver } from './image-driver';
export type {
  ImageInput,
  ImageQuery,
  ImageSourceSet,
  ModernFormat,
  ResponsiveImage,
  ResponsiveImageOptions,
} from './images';
export {
  DEFAULT_WIDTHS,
  FORMAT_ORDER,
  IMAGE_QUERY_KEYS,
  inlineBlur,
  MIME_TYPES,
  parseImageQuery,
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
  hreflangSet,
  renderMeta,
  robotsContent,
  TITLE_MAX_LENGTH,
} from './meta';
export type { RobotsConfig, RobotsGroup } from './robots';
export { buildRobots, isIndexable } from './robots';
export type { ChangeFreq, RouteRecord, Surface } from './routes';
export { expandRoute, indexableRoutes, isDynamic } from './routes';
export type { BuildFeedOptions, Feed, FeedAuthor, FeedChannel, FeedItem } from './rss';
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
