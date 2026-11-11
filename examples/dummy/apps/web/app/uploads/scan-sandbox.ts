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
import type { ScanInput, ScanVerdict, UploadScanner } from '@ultimat3/storage/adapter';

/** What a file waiting in the sandbox is held with — `meta.reason` of `X_STORAGE_QUARANTINED`. */
export const SANDBOX_PENDING = 'in the malware sandbox; confirm the same upload again shortly';

/** How long a verdict stands: a day. Past it the same bytes are submitted, and held, again. */
export const SANDBOX_VERDICT_TTL_MS = 24 * 3_600_000;

export interface ScanSandbox {
  /** The sandbox's verdict on THESE bytes of `pendingKey`, or `hold` while it has none yet. */
  check(input: ScanInput): Promise<ScanVerdict>;
}

export interface ScanSandboxSeams {
  readonly clock?: Clock | undefined;
  /** What detonates a submission — the vendor's side. Called once per submission, never per poll. */
  readonly engine?: UploadScanner | undefined;
}

interface Submission {
  /** WHICH bytes were judged: a verdict is about them, never about the key they sat under. */
  readonly revision: string;
  readonly verdict: ScanVerdict;
  readonly at: number;
}

/**
 * `ScanInput.revision` — the upload's etag, or its SHA-256 on a disk that keeps none — names the
 * bytes before a byte is read, so a poll for bytes already judged sends nothing. A caller from
 * before 31.3 passes none: the bytes are hashed while they are submitted, and every ask is new.
 */
async function submitted(
  engine: UploadScanner,
  input: ScanInput,
): Promise<{ revision: string; verdict: ScanVerdict }> {
  if (input.revision !== undefined) {
    return { revision: input.revision, verdict: await engine.scan(input) };
  }
  const [toScan, toHash] = input.body.tee();
  const hasher = new Bun.CryptoHasher('sha256');
  const hashing = (async () => {
    for await (const chunk of toHash) hasher.update(chunk);
  })();
  const verdict = await engine.scan({ ...input, body: toScan });
  await hashing;
  return { revision: `sha256:${hasher.digest('hex')}`, verdict };
}

export function memoryScanSandbox(seams: ScanSandboxSeams = {}): ScanSandbox {
  const clock = seams.clock ?? systemClock;
  const engine = seams.engine ?? memoryUploadScanner();
  const submissions = new Map<string, Submission>();
  return {
    async check(input) {
      const now = clock.now().getTime();
      for (const [key, held] of submissions) {
        if (now - held.at >= SANDBOX_VERDICT_TTL_MS) submissions.delete(key);
      }
      const held = submissions.get(input.pendingKey);
      // The revision the sandbox already judged: its verdict, and the bytes are not sent again.
      if (held !== undefined && input.revision !== undefined && held.revision === input.revision) {
        await input.body.cancel();
        return held.verdict;
      }
      const fresh = await submitted(engine, input);
      if (held?.revision === fresh.revision) return held.verdict;
      submissions.set(input.pendingKey, { ...fresh, at: now });
      return { verdict: 'hold', reason: SANDBOX_PENDING };
    },
  };
}
