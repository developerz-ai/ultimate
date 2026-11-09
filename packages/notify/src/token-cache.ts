// Single responsibility: one bearer credential, minted once and reused until shortly before it
// expires. A fan-out to a thousand devices signs ONE APNs token and exchanges ONE Google assertion,
// and concurrent sends share the mint in flight rather than each starting their own.

export interface MintedToken {
  readonly value: string;
  /** Epoch ms after which the provider refuses it. */
  readonly expiresAt: number;
}

export interface TokenCache {
  /** The cached token, or a fresh one once it is within `refreshBeforeMs` of expiring. */
  get(): Promise<string>;
  /**
   * Forget `stale` — the token the provider just refused — so the next send mints again. Only
   * when it is still the cached one: a straggler's late refusal for a token already replaced
   * would otherwise drop the fresh one and re-sign, and Apple throttles a re-sign inside 20 min.
   * A mint in flight is left alone: it started after `stale` was handed out.
   */
  invalidate(stale: string): void;
}

export function tokenCache(
  mint: () => Promise<MintedToken>,
  now: () => number,
  refreshBeforeMs: number,
): TokenCache {
  let current: MintedToken | undefined;
  let pending: Promise<MintedToken> | undefined;
  return {
    async get() {
      if (current !== undefined && now() < current.expiresAt - refreshBeforeMs) {
        return current.value;
      }
      if (pending === undefined) {
        const minting = mint();
        pending = minting;
        // A failed mint is never cached: the next send tries again rather than replaying it.
        minting.then(
          (token) => {
            if (pending === minting) current = token;
          },
          () => undefined,
        );
        minting
          .finally(() => {
            if (pending === minting) pending = undefined;
          })
          .catch(() => undefined);
      }
      return (await pending).value;
    },
    invalidate(stale) {
      if (current?.value === stale) current = undefined;
    },
  };
}
