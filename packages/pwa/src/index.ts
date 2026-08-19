/** Public API of `@ultimat3/pwa`. You never open `sw.js`; you call these. */

export type { BackgroundSyncOptions, RetryPolicy } from './background-sync';
export {
  backgroundSyncSource,
  DEFAULT_FLUSH_ENDPOINT,
  DEFAULT_RETRY,
  PERIODIC_SYNC_TAG,
  registerBackgroundSyncSource,
  retryDelayMs,
  SYNC_TAG,
  shouldRetry,
} from './background-sync';
export type { Capability, CapabilityFlags, ResolvedCapabilities } from './capabilities';
export {
  CAPABILITIES,
  CAPABILITY_MANIFEST_KEYS,
  CAPABILITY_SW_MARKERS,
  enabledCapabilities,
  isEnabled,
  resolveCapabilities,
} from './capabilities';
export type { PwaErrorCode } from './errors';
export {
  BuildIdMissingError,
  NotImplementedError,
  PWA_ERROR_CODES,
  PWA_ERROR_TITLES,
  PwaIconMissingError,
  PwaManifestInvalidError,
  PwaNoOfflineFallbackError,
  // `staleWhileRevalidate` is public and throws this, so an app that catches it can name it. The
  // two X_PWA_SYNC_* classes are not here on purpose: the emitted `sw.js` builds its own local
  // class in a realm with no bundler, so no instance of theirs can ever reach an app.
  PwaStrategyExhaustedError,
  SwScopeInvalidError,
} from './errors';
export type {
  IconPlan,
  IconPlanEntry,
  IconPurpose,
  IconSourceConfig,
  IconSpec,
  ImagePipeline,
  ImageTransform,
  SafeZone,
  SplashSpec,
} from './icons';
export {
  appleTouchLinks,
  BuiltinImagePipeline,
  ICON_MATRIX,
  MASKABLE_PADDING,
  maskableSafeZone,
  planIcons,
  requireSourceIcon,
  SPLASH_MATRIX,
} from './icons';
export type {
  BeforeInstallPromptEventLike,
  InstallController,
  InstallHost,
  InstallOptions,
  InstallOutcome,
  IosGuidance,
  ReadSignal,
} from './install';
export { createInstallController, iosInstallGuidance, MIN_ENGAGEMENT_MS } from './install';
export type {
  DisplayMode,
  FileHandler,
  ManifestIcon,
  ManifestScreenshot,
  ManifestShortcut,
  Orientation,
  ProtocolHandler,
  PwaConfig,
  SchemeColors,
  ShareTarget,
  ThemeColorMeta,
  ThemeTokens,
  WebManifest,
  WebManifestResult,
} from './manifest';
export { generateWebManifest, renderThemeColorMeta, serializeWebManifest } from './manifest';
export type { OfflineConfig, OfflineFallback } from './offline-fallback';
export { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';
export type { PrecacheAsset, PrecacheEntry, PrecacheInput, PrecacheManifest } from './precache';
export {
  buildPrecacheManifest,
  DEFAULT_PRECACHE_WARN_BYTES,
  formatBytes,
  serializePrecacheManifest,
} from './precache';
export type {
  PushPayload,
  PushSourceOptions,
  PushSubscriptionKeys,
  PushSubscriptionRecord,
  RenderedNotification,
  SubscriptionState,
  Translate,
  VapidConfig,
} from './push';
export {
  pushSource,
  renderPushPayload,
  serializePushMessage,
  subscribeSource,
  subscriptionState,
} from './push';
export type { RouteRule, ServiceWorkerConfig, ServiceWorkerOutput } from './service-worker';
export { assertScope, generateServiceWorker, routeRules } from './service-worker';
export type {
  PwaOfflineStrategy,
  PwaRenderMode,
  PwaRoute,
  StrategyCache,
  StrategyEnv,
  StrategyName,
  StrategyOptions,
} from './strategies';
export {
  cacheFirst,
  MODE_STRATEGY,
  networkFirst,
  networkOnly,
  STRATEGY_FN_NAMES,
  STRATEGY_FNS,
  STRATEGY_NAMES,
  STRATEGY_SOURCE,
  staleWhileRevalidate,
  strategyFor,
} from './strategies';
export type {
  AppUpdateAvailable,
  BuildIdInput,
  Deploy,
  DeployChannel,
  ForceReason,
  RetentionPlan,
  SkewState,
  UpdatePolicy,
  UpdatePolicyInput,
  UpdateSignalInput,
} from './version-skew';
export {
  APP_UPDATE_AVAILABLE,
  assertBuildId,
  BUILD_ID_HEADER,
  BUILD_ID_META,
  buildId,
  cacheNamespace,
  DEFAULT_GRACE_MS,
  detectSkew,
  retentionPlan,
  updatePolicy,
  updateSignal,
} from './version-skew';
