/**
 * The malware sandbox Postly sends LARGE uploads to, faked in memory as the billing vendor is
 * (`app/billing/vendor-payments.ts`): this app has no vendor account, and a reference app that
 * called one would gate on the network. A real sandbox detonates the file asynchronously and is
 * polled by id; this one takes the bytes on the first ask and has its verdict ready by the next —
 * for the same bytes only, and for a day.
 *
 * Its verdict engine is storage's reference (`memoryUploadScanner`, the EICAR test string), so a
 * test can make it answer `infected` with a known file. Process-local, which is the fake's
 * honesty: a second replica asks a sandbox that never saw the bytes and holds them again.
 */

import { type Clock, systemClock } from '@ultimat3/core';
import { memoryUploadScanner } from '@ultimat3/storage';
import type { ScanInput, ScanVerdict } from '@ultimat3/storage/adapter';

/** What a file waiting in the sandbox is held with — `meta.reason` of `X_STORAGE_QUARANTINED`. */
export const SANDBOX_PENDING = 'in the malware sandbox; confirm the same upload again shortly';

/** How long a verdict stands: a day. Past it the same bytes are submitted, and held, again. */
export const SANDBOX_VERDICT_TTL_MS = 24 * 3_600_000;

export interface ScanSandbox {
  /** The sandbox's verdict on THESE bytes of `pendingKey`, or `hold` while it has none yet. */
  check(input: ScanInput): Promise<ScanVerdict>;
  /** How many submissions it holds — what a test reads to prove the bytes were sent once. */
  readonly submitted: () => number;
}

interface Submission {
  /** SHA-256 of the bytes judged: a verdict is about them, never about the key they sat under. */
  readonly digest: string;
  readonly verdict: ScanVerdict;
  readonly at: number;
}

/**
 * The body, judged by the engine and hashed in the same read. The upload stays writable under
 * `pending/` while it is held — a presigned PUT outlives the hold — so a verdict for the key alone
 * would clear whatever was swapped in after it: the digest is what the verdict belongs to.
 */
async function judged(
  engine: ReturnType<typeof memoryUploadScanner>,
  input: ScanInput,
): Promise<{ digest: string; verdict: ScanVerdict }> {
  const [toScan, toHash] = input.body.tee();
  const hasher = new Bun.CryptoHasher('sha256');
  const hashing = (async () => {
    for await (const chunk of toHash) hasher.update(chunk);
  })();
  const verdict = await engine.scan({ ...input, body: toScan });
  await hashing;
  return { digest: hasher.digest('hex'), verdict };
}

export function memoryScanSandbox(clock: Clock = systemClock): ScanSandbox {
  const engine = memoryUploadScanner();
  const submissions = new Map<string, Submission>();
  return {
    async check(input) {
      const now = clock.now().getTime();
      for (const [key, held] of submissions) {
        if (now - held.at >= SANDBOX_VERDICT_TTL_MS) submissions.delete(key);
      }
      const { digest, verdict } = await judged(engine, input);
      const held = submissions.get(input.pendingKey);
      // The bytes the sandbox already judged: its verdict. Anything else is a new submission.
      if (held?.digest === digest) return held.verdict;
      submissions.set(input.pendingKey, { digest, verdict, at: now });
      return { verdict: 'hold', reason: SANDBOX_PENDING };
    },
    submitted: () => submissions.size,
  };
}
