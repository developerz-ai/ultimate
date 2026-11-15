// No-op bodies for the verbs `CdpPageLike` and `CdpBrowserLike` REQUIRE, for a test double that is
// about something else — interception, redaction, a wedge. Spread them in; override one.
//
// They exist because the port stopped letting a launcher omit a verb `cdpTarget` forwards to
// (2026-11-15), and twenty hand-built pages each restating seven no-ops is a copy that drifts.

import type { CdpBrowserLike, CdpPageLike } from './cdp-port';

type PageVerbs = Pick<
  CdpPageLike,
  | 'keyboard'
  | 'focus'
  | 'evaluateOnNewDocument'
  | 'createCDPSession'
  | 'setOfflineMode'
  | 'emulateMediaFeatures'
>;

export function stubPageVerbs(): PageVerbs {
  return {
    keyboard: {
      down: () => Promise.resolve(),
      up: () => Promise.resolve(),
      press: () => Promise.resolve(),
    },
    focus: () => Promise.resolve(),
    evaluateOnNewDocument: () => Promise.resolve(undefined),
    createCDPSession: () =>
      Promise.resolve({ send: () => Promise.resolve({}), detach: () => Promise.resolve() }),
    setOfflineMode: () => Promise.resolve(),
    emulateMediaFeatures: () => Promise.resolve(),
  };
}

/** An empty jar that accepts what it is given — a browser the test never reads cookies from. */
export function stubCookieJar(): Pick<CdpBrowserLike, 'cookies' | 'setCookie'> {
  return { cookies: () => Promise.resolve([]), setCookie: () => Promise.resolve() };
}
