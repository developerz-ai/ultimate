// Single responsibility: the SNS signing certificates a receiver has downloaded, bounded against a
// sender who forges messages. Any pinned URL reaches the download BEFORE a signature is checked,
// and an allowed topic ARN is not a secret, so a forger can name a fresh path per request. Four
// bounds hold that to a fixed cost: LRU positives, a negative TTL, an in-flight cap, coalescing.

import { type Clock, isUltimateError, renderThrowable, systemClock } from '@ultimat3/core';
import { deliveryProviderUnreachable } from './delivery-event-errors';
import { certificateSpki, pemCertificateDer } from './x509-spki';

/** PEM text for a certificate URL. Injected in tests; production GETs it over pinned https. */
export type SnsCertificateFetch = (url: string) => Promise<string>;

/** SNS uses a handful of certificates per region; eight keeps every live one with room to rotate. */
const MAX_CERTIFICATES = 8;
/** Downloads at once. A flood waits on nothing: past this it is refused with a 503 SNS retries. */
const MAX_IN_FLIGHT = 2;
/** How long a URL that failed to download is answered from memory instead of fetched again. */
const NEGATIVE_TTL_MS = 300_000;
/** Remembered failures. Bounded too, or the negative cache is the next thing to flood. */
const MAX_FAILURES = 256;

export interface SnsCertificateCache {
  /** The SPKI for a pinned certificate URL — cached, coalesced, or refused. */
  spkiFor(url: string): Promise<Uint8Array<ArrayBuffer>>;
}

export interface SnsCertificateCacheOptions {
  readonly fetchCertificate: SnsCertificateFetch;
  readonly clock?: Clock | undefined;
}

export function createSnsCertificateCache(
  options: SnsCertificateCacheOptions,
): SnsCertificateCache {
  const clock = options.clock ?? systemClock;
  // Insertion order is recency order: a hit is deleted and re-set, so the first key is the LRU.
  const verified = new Map<string, Uint8Array<ArrayBuffer>>();
  const failedUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

  const remember = <V>(map: Map<string, V>, key: string, value: V, max: number): void => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  };

  async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
    let pem: string;
    try {
      pem = await options.fetchCertificate(url);
    } catch (error) {
      // The default download already names its failure; an injected one may throw anything.
      if (isUltimateError(error)) throw error;
      throw deliveryProviderUnreachable('certificate', renderThrowable(error));
    }
    const der = pemCertificateDer(pem);
    const spki = der === undefined ? undefined : certificateSpki(der);
    if (spki === undefined) {
      throw deliveryProviderUnreachable(
        'certificate',
        'the answer was not a PEM X.509 certificate',
      );
    }
    return new Uint8Array(spki);
  }

  return {
    spkiFor(url) {
      const hit = verified.get(url);
      if (hit !== undefined) {
        remember(verified, url, hit, MAX_CERTIFICATES);
        return Promise.resolve(hit);
      }
      const pending = inFlight.get(url);
      if (pending !== undefined) return pending;
      const now = clock.monotonic();
      const until = failedUntil.get(url);
      if (until !== undefined && now < until) {
        return Promise.reject(
          deliveryProviderUnreachable('certificate', 'this URL failed to download moments ago'),
        );
      }
      if (inFlight.size >= MAX_IN_FLIGHT) {
        return Promise.reject(
          deliveryProviderUnreachable('certificate', 'too many certificate downloads in flight'),
        );
      }
      const started = download(url).then(
        (spki) => {
          failedUntil.delete(url);
          remember(verified, url, spki, MAX_CERTIFICATES);
          return spki;
        },
        (error: unknown) => {
          remember(failedUntil, url, clock.monotonic() + NEGATIVE_TTL_MS, MAX_FAILURES);
          throw error;
        },
      );
      inFlight.set(url, started);
      // `finally` on a branch whose rejection is observed by the caller, never left unhandled.
      started.then(
        () => inFlight.delete(url),
        () => inFlight.delete(url),
      );
      return started;
    },
  };
}
