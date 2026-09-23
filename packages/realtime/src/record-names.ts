// Which pending overlay a `records` frame's `write` names. The node stamps a frame with the digest
// of the idempotency key its write arrived under (`writeDigest`, `@ultimat3/core`); the page digests
// its own keys as it pushes them, so a frame is recognised as this page's own echo by lookup.

import { writeDigest } from '@ultimat3/core/page';

export class WriteNames {
  readonly #byDigest = new Map<string, string>();
  readonly #byKey = new Map<string, string>();

  /**
   * Digest `key` and remember it while `pending(key)` still holds. Started when the overlay is
   * pushed, before its request is sent: the digest resolves in microseconds and the echo needs the
   * request to reach the node, commit and fan back out first. No `crypto.subtle` (plain HTTP off
   * `localhost`) names nothing, and the echo is a plain merge — the behaviour before frames named
   * their write.
   */
  name(key: string, pending: (key: string) => boolean): void {
    void writeDigest(key).then(
      (digest) => {
        if (digest === undefined || !pending(key)) return;
        this.#byDigest.set(digest, key);
        this.#byKey.set(key, digest);
      },
      () => undefined,
    );
  }

  /** The overlay `digest` names, if it is one this page pushed and still holds. */
  keyOf(digest: string): string | undefined {
    return this.#byDigest.get(digest);
  }

  forget(key: string): void {
    const digest = this.#byKey.get(key);
    if (digest === undefined) return;
    this.#byKey.delete(key);
    this.#byDigest.delete(digest);
  }

  clear(): void {
    this.#byDigest.clear();
    this.#byKey.clear();
  }
}
