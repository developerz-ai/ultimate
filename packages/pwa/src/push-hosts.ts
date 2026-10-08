// Single responsibility: which hosts the push sender may dial. An endpoint is a URL from a REQUEST
// BODY, and a hostname resolves wherever its owner points it — a private address, the cloud
// metadata service — so checking the name's shape (`https:`, not an IP literal) is not a screen.
// The one that holds is a list of the push services browsers actually hand out, checked when a
// subscription is stored AND before every send; an app adds its own with `pwa.vapid.pushHosts`.

/**
 * Every push service a current browser subscribes with, `As of 2026-10`. Each matches itself and
 * its subdomains, on a dot boundary — `fcm.googleapis.com.evil.com` and `evilpush.apple.com` match
 * nothing.
 *
 * | Host | Browser | Endpoints look like |
 * |---|---|---|
 * | `fcm.googleapis.com` | Chrome, Edge on Android, every Chromium | `https://fcm.googleapis.com/fcm/send/…`, `…/wp/…` |
 * | `push.services.mozilla.com` | Firefox | `https://updates.push.services.mozilla.com/wpush/v2/…` |
 * | `push.apple.com` | Safari (macOS, iOS 16.4+) | `https://web.push.apple.com/…` |
 * | `notify.windows.com` | Edge on Windows (WNS) | `https://wns2-<region>.notify.windows.com/w/?token=…` |
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = Object.freeze([
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
]);

/** `host` is `listed` itself or a subdomain of it — compared lower-case, on a dot boundary. */
const under = (host: string, listed: string): boolean =>
  host === listed || host.endsWith(`.${listed}`);

/** Whether `host` is a built-in push service or one the app listed (`pwa.vapid.pushHosts`). */
export function pushHostAllowed(host: string, extra: readonly string[] = []): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return [...PUSH_SERVICE_HOSTS, ...extra].some((listed) => under(name, listed.toLowerCase()));
}
