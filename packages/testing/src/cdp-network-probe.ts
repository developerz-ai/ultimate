// One responsibility: proving a page's NETWORK agrees with the offline switch, by sending a request.
// `navigator.onLine` is not that proof: Chrome tells the renderer before the network service applies
// the condition (two pipes, no order between them), so a `fetch` on the next line went through under
// a cut the page already read as offline — `browser-harness.e2e.test.ts`, CI run 39223207154.

import type { CdpResult } from './cdp-connection';

type Send = (
  method: string,
  params: Record<string, unknown>,
  session: string,
  deadlineMs?: number,
) => Promise<CdpResult>;

/** The probe's path: under `/_x/`, which no app route owns, so the app answers it 404 and does nothing. */
export const NETWORK_PROBE_PATH = '/_x/network-probe';

/**
 * `HEAD`, because the framework's service worker answers GET only — a GET could be served from its
 * cache or its offline document, and read as `reached` under a cut forever. `none` on a page that is
 * not on http(s) (`about:blank`): it has no origin to ask, and nothing on it can fetch either.
 */
export const NETWORK_PROBE = `(async () => {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return 'none';
  try {
    await fetch('${NETWORK_PROBE_PATH}', { method: 'HEAD', cache: 'no-store' });
    return 'reached';
  } catch {
    return 'refused';
  }
})()`;

/** Whether a logged request URL is a probe — kept out of the session's request log. */
export const isNetworkProbe = (url: string): boolean => {
  try {
    return new URL(url).pathname === NETWORK_PROBE_PATH;
  } catch {
    return false;
  }
};

const probeValue = (answer: CdpResult): unknown => {
  const result = answer.result?.['result'];
  return typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)['value']
    : undefined;
};

/**
 * Probes one page until a request from it is refused (`online` false) or reaches the server
 * (`online` true), and answers `false` at `deadline`. Each probe is itself a round trip to the
 * network, so the loop paces itself — no sleep. A probe refused by a navigation is asked again.
 */
export async function networkAgrees(
  send: Send,
  session: string,
  online: boolean,
  deadline: number,
): Promise<boolean> {
  const wanted = online ? 'reached' : 'refused';
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    try {
      const answer = await send(
        'Runtime.evaluate',
        { expression: NETWORK_PROBE, returnByValue: true, awaitPromise: true },
        session,
        remaining,
      );
      const value = probeValue(answer);
      if (value === wanted || value === 'none') return true;
    } catch {
      // A navigation destroyed the context, or the call ran out of time: the deadline decides.
    }
    // One macrotask between probes: a refusal that settles as a microtask would otherwise starve
    // every timer and socket in the process until the deadline.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
