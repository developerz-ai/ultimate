// One outbound link, asked once: is the page still there? Only a 404 or a 410 says it is gone. A
// 403 or a 429 is the host's answer about this client, so reporting one would be a false alarm.

/** The part of `fetch` a probe uses, so its test needs no network. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LinkProbe {
  readonly verdict: 'alive' | 'dead' | 'unreachable';
  /** The final status, `null` when no answer came. */
  readonly status: number | null;
}

const PROBE_TIMEOUT_MS = 10_000;
const GONE: readonly number[] = [404, 410];

export async function probeLink(url: string, send: ProbeFetch = fetch): Promise<LinkProbe> {
  try {
    const { status } = await send(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { verdict: GONE.includes(status) ? 'dead' : 'alive', status };
  } catch {
    // why: a refused connection, a DNS failure and the deadline are one fact about this link, and
    // the run's result reports it. Thrown, one flaky host would fail the run for every other link.
    return { verdict: 'unreachable', status: null };
  }
}
