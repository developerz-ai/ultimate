/**
 * The `<meta name>`s a rendered document hands its page client. Tier 0 because the WRITER is
 * `@ultimat3/render` (tier 4) and the READERS are core's `pageClient()`, `@ultimat3/realtime`'s
 * socket host (tier 3) and `@ultimat3/pwa`'s skew check — one literal per fact, never retyped.
 */

/** The page's principal: content = that principal, empty = anonymous, absent = unscoped. */
export const CLIENT_SCOPE_META = 'ultimate-scope';

/**
 * The build id the document was rendered by. `x-ultimate-build` — the same spelling as the header,
 * and the one `@ultimat3/pwa` shipped as `BUILD_ID_META`, so no shipped reader changes.
 */
export const CLIENT_BUILD_META = 'x-ultimate-build';

/**
 * `event.data.type` of the message a service worker posts to its windows when a newer build is
 * waiting (`{ type, to: <build id> }`). Sent by `@ultimat3/pwa`'s emitted `sw.js`, read by an app's
 * update banner — one literal both import, beside the build id it is about.
 */
export const APP_UPDATE_MESSAGE = 'AppUpdateAvailable';

/** Where the page's one socket dials: `/_x/sync`, or the deployment's absolute `SYNC_URL`. */
export const CLIENT_SYNC_META = 'ultimate-sync';

/** The worker script that hosts the socket; absent when the app has no realtime. */
export const CLIENT_SYNC_WORKER_META = 'ultimate-sync-worker';

/**
 * The record types the client keeps on disk — the entities registered with `persist: true`,
 * comma-separated (`post,comment`). The browser holds no entity declarations, so this is the one
 * place it learns which types `@ultimat3/realtime`'s persister may write. Absent = none.
 */
export const CLIENT_PERSIST_META = 'ultimate-persist';
