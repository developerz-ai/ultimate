/** Public API of `@ultimat3/pwa`. You never open `sw.js`; you call these. */

/**
 * `PwaRenderMode` and `PwaOfflineStrategy` were this package's own NAMES for tier 0's vocabulary —
 * the alias was the copy. `PwaRoute` takes both in its signature, so the canonical names are
 * re-exported here; a consumer still needs one import, and now it names the real type.
 */
export type { OfflineStrategy, RenderMode } from '@ultimat3/core';
export {
  backgroundSyncSource,
  registerBackgroundSyncSource,
  SYNC_TAG,
} from './background-sync';
export type { Capability, CapabilityFlags, ResolvedCapabilities } from './capabilities';
export {
  CAPABILITIES,
  CAPABILITY_SW_MARKERS,
  enabledCapabilities,
  hasCapability,
  resolveCapabilities,
} from './capabilities';
export type { PwaErrorCode } from './errors';
export {
  BuildIdMissingError,
  PWA_ERROR_CODES,
  PWA_ERROR_TITLES,
  PwaIconMissingError,
  PwaManifestInvalidError,
  PwaNoOfflineFallbackError,
  // `staleWhileRevalidate` is public and throws this, so an app that catches it can name it. The
  // two X_PWA_SYNC_* classes are not here on purpose: the emitted `sw.js` builds its own local
  // class in a realm with no bundler, so no instance of theirs can ever reach an app.
  PwaPushFailedError,
  PwaPushPayloadTooLargeError,
  PwaPushRejectedError,
  PwaPushSubscriptionInvalidError,
  PwaPushUnconfiguredError,
  PwaStrategyExhaustedError,
  PwaVapidKeyInvalidError,
  PwaVapidKeyMissingError,
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
export { installController, iosInstallGuidance } from './install';
export type {
  DisplayMode,
  FileHandler,
  ManifestIcon,
  ManifestScreenshot,
  ManifestShortcut,
  Orientation,
  ProtocolHandler,
  ShareTarget,
  ThemeColorMeta,
  WebManifest,
  WebManifestInput,
  WebManifestResult,
} from './manifest';
export { generateWebManifest, renderThemeColorMeta, serializeWebManifest } from './manifest';
export type { OfflineConfig, OfflineFallback } from './offline-fallback';
export { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';
export type { PersonalPages } from './pages-cache-source';
export { CLEAR_PAGES_MESSAGE, PAGES_CLEARED_MESSAGE } from './pages-cache-source';
export type { PrecacheAsset, PrecacheEntry, PrecacheInput, PrecacheManifest } from './precache';
export {
  buildPrecacheManifest,
  DEFAULT_PRECACHE_WARN_BYTES,
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
  subscribeSource,
  subscriptionState,
} from './push';
export type { PushSubscriptionActionOptions } from './push-actions';
export { pushSubscribe, pushUnsubscribe } from './push-actions';
// The browser half is `@ultimat3/pwa/client` (`push-client.ts`), never this barrel: an island
// importing it would pull the service-worker generator into a page bundle. Its meta name is
// re-exported here because the SERVER writes the tag the client reads.
export { PUSH_KEY_META } from './push-client';
export type { PushReceiverKeys } from './push-decrypt';
export { decryptPushMessage } from './push-decrypt';
export type { PushEncryptionKeys, PushEncryptOptions } from './push-encrypt';
export { encryptPushMessage, PUSH_RECORD_SIZE, pushMessageCapacity } from './push-encrypt';
export type { WebPushOptions, WebPushRuntime } from './push-runtime';
export { installedVapid, installWebPush, resetWebPush, webPushRuntime } from './push-runtime';
export type {
  PushDelivery,
  PushSendInput,
  PushSendOutcome,
  PushTarget,
  PushUrgency,
  VapidSigner,
} from './push-send';
export {
  DEFAULT_PUSH_TTL_SECONDS,
  PUSH_URGENCIES,
  pushEndpointProblem,
  sendPushMessage,
} from './push-send';
export type { PushSubscriptionStore } from './push-store';
export { memoryPushSubscriptionStore } from './push-store';
export type { PostgresPushSubscriptionStoreOptions } from './push-store-pg';
export { postgresPushSubscriptionStore } from './push-store-pg';
export type { RouteRule } from './route-rules';
export { assetRules, routeRules } from './route-rules';
export type { ServiceWorkerConfig, ServiceWorkerOutput } from './service-worker';
export { assertScope, generateServiceWorker, PRECACHE_CONCURRENCY } from './service-worker';
export type {
  PwaRoute,
  StrategyCache,
  StrategyEnv,
  StrategyName,
  StrategyOptions,
} from './strategies';
export {
  cacheFirst,
  fromNetwork,
  MODE_STRATEGY,
  networkFirst,
  networkOnly,
  STRATEGY_NAMES,
  staleWhileRevalidate,
  strategyFor,
} from './strategies';
export type { VapidKeyPair, VapidTokenInput } from './vapid';
export {
  assertVapidPair,
  generateVapidKeys,
  importVapidKeys,
  VAPID_PRIVATE_KEY_ENV,
  VAPID_PUBLIC_KEY_ENV,
  VAPID_TOKEN_TTL_SECONDS,
  vapidAuthorization,
} from './vapid';
export type { ResolvedVapidKeys } from './vapid-keys';
export { DEV_VAPID_KEYS, resolveVapidKeys, usesDevVapidKeys } from './vapid-keys';
// The forced-reload half of this module is gone as of 9.0.0 — `updateSignal`, `updatePolicy`,
// `DEFAULT_GRACE_MS`, `ForceReason`, `UpdatePolicy`, `UpdatePolicyInput`, `UpdateSignalInput`.
// It computed `forced`/`deadlineAt` for a client-side reload no code in the framework performed,
// from a caller that never existed. What remains is what runs: an id, a comparison, a retention
// plan, and the message the generated worker really posts.
export type {
  AppUpdateAvailable,
  BuildIdInput,
  Deploy,
  DeployChannel,
  RetentionPlan,
  SkewState,
} from './version-skew';
export {
  assertBuildId,
  buildId,
  cacheNamespace,
  detectSkew,
  retentionPlan,
} from './version-skew';
export type { PushNotification, PushReport, WebPusher } from './web-push';
export { pushToActor, webPush } from './web-push';
