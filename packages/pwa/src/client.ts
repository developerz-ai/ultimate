// `@ultimat3/pwa/client` — THE browser entry of this package: everything an island or a page script
// may call, and nothing that drags the server half along. The `.` barrel reaches the icon pipeline
// (core's image transform, Node-only), the service-worker generator and the push sender; this
// entry's graph is these four files and `@ultimat3/core/page`, held there by `client-bundle.test.ts`.
//
//   import { detectSkew, installController, subscribeToPush } from '@ultimat3/pwa/client';
//
// The worker's message TYPE (`'AppUpdateAvailable'`) is core's `APP_UPDATE_MESSAGE`, imported from
// `@ultimat3/core/page` — one name, one home (`X_HELPER_COPY`); `AppUpdateAvailable` types it here.

export type {
  BeforeInstallPromptEventLike,
  InstallController,
  InstallHost,
  InstallOptions,
  InstallOutcome,
  IosGuidance,
  ReadSignal,
} from './install';
export { installController, iosInstallGuidance, MIN_ENGAGEMENT_MS } from './install';
export type {
  PushClientHost,
  PushPermission,
  PushRegistrationLike,
  PushSubscribeOutcome,
  PushSubscriptionInput,
  PushSubscriptionLike,
} from './push-client';
export {
  browserPushHost,
  PUSH_KEY_META,
  pushPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from './push-client';
export type { AppUpdateAvailable, SkewState } from './skew';
export { detectSkew } from './skew';
