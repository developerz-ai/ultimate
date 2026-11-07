// Single responsibility: what one native device registration is — its platform, its token's
// shape, the store seam it lives behind, and the in-memory store a test or a single process uses.
// The Postgres store is `push-device-pg.ts`.
//
// A device is keyed by `(platform, token)`, never by actor: a token names one app install, and when
// a second person signs in on that phone the registration is theirs now — keyed by the actor too,
// the first person would go on receiving the second person's notifications.

/** The two native transports `nativePush()` speaks: APNs for `ios`, FCM for `android`. */
export const PUSH_PLATFORMS = ['ios', 'android'] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * An APNs device token is hex — 32 bytes today, and Apple says it may grow, so up to 100. It is
 * spliced into the APNs URL PATH, so anything else is refused rather than escaped: a token is
 * never a place a `/` or a `?` reaches the provider from.
 */
export const APNS_TOKEN = /^(?:[0-9a-fA-F]{2}){32,100}$/;

/** An FCM registration token: URL-safe base64 with `:` and `-`, 4 KiB at most. */
export const FCM_TOKEN = /^[A-Za-z0-9_:.-]{32,4096}$/;

/** Whether `token` is one `platform`'s provider could ever accept — read at register AND send. */
export const isDeviceToken = (platform: PushPlatform, token: string): boolean =>
  (platform === 'ios' ? APNS_TOKEN : FCM_TOKEN).test(token);

/** One app install's registration. Tokens are stored lowercase for `ios`, as APNs reads them. */
export interface PushDeviceRecord {
  readonly platform: PushPlatform;
  readonly token: string;
  readonly actorId: string;
  /** BCP-47 — a visible push to this device renders in it. */
  readonly locale: string;
  /** IANA — the zone a push formatting a date would need. */
  readonly timeZone: string;
  /** Epoch ms of the first registration; a re-register keeps it. */
  readonly createdAt: number;
  /**
   * Bad-token answers in a row (`noteBadToken`), present only when above 0 — a store writes it,
   * a caller of `save` never does, and a re-register keeps it: the token is no better for it.
   */
  readonly badTokens?: number | undefined;
}

export interface PushDeviceStore {
  /** Insert, or hand an existing `(platform, token)` to this record's actor and locale. */
  save(record: PushDeviceRecord): Promise<void>;
  /** Every device of one actor, ordered `(platform, token)` by code point in both stores. */
  listFor(actorId: string): Promise<readonly PushDeviceRecord[]>;
  /**
   * Delete one device. With `actorId`, only when it is that actor's — an unregister names its
   * owner, so a token somebody else holds is simply absent. Without, unconditionally — the
   * sender's answer to a provider saying the token is dead, whoever held it.
   */
  remove(platform: PushPlatform, token: string, actorId?: string): Promise<boolean>;
  /** One more bad-token answer for this device; the count after it, `0` when there is no row. */
  noteBadToken(platform: PushPlatform, token: string): Promise<number>;
  /** It delivered: the bad-token answers before it were not in a row after all. */
  clearBadToken(platform: PushPlatform, token: string): Promise<void>;
}

const keyOf = (platform: PushPlatform, token: string): string => `${platform}\u0000${token}`;

const byDevice = (a: PushDeviceRecord, b: PushDeviceRecord): number => {
  const left = keyOf(a.platform, a.token);
  const right = keyOf(b.platform, b.token);
  return left < right ? -1 : left > right ? 1 : 0;
};

/** One process's devices. Lost on restart, which is the right fate for a test's. */
export function memoryPushDeviceStore(): PushDeviceStore {
  const rows = new Map<string, PushDeviceRecord>();
  return {
    save(record) {
      const key = keyOf(record.platform, record.token);
      const existing = rows.get(key);
      // The first `createdAt` and the bad-token count survive a re-register, as `on conflict do
      // update` leaves both.
      const { badTokens: _ignored, ...fields } = record;
      rows.set(
        key,
        existing === undefined
          ? fields
          : {
              ...fields,
              createdAt: existing.createdAt,
              ...(existing.badTokens === undefined ? {} : { badTokens: existing.badTokens }),
            },
      );
      return Promise.resolve();
    },
    noteBadToken(platform, token) {
      const key = keyOf(platform, token);
      const row = rows.get(key);
      if (row === undefined) return Promise.resolve(0);
      const badTokens = (row.badTokens ?? 0) + 1;
      rows.set(key, { ...row, badTokens });
      return Promise.resolve(badTokens);
    },
    clearBadToken(platform, token) {
      const key = keyOf(platform, token);
      const row = rows.get(key);
      if (row !== undefined) {
        const { badTokens: _cleared, ...rest } = row;
        rows.set(key, rest);
      }
      return Promise.resolve();
    },
    listFor(actorId) {
      return Promise.resolve(
        [...rows.values()].filter((row) => row.actorId === actorId).sort(byDevice),
      );
    },
    remove(platform, token, actorId) {
      const key = keyOf(platform, token);
      const row = rows.get(key);
      if (row === undefined || (actorId !== undefined && row.actorId !== actorId)) {
        return Promise.resolve(false);
      }
      rows.delete(key);
      return Promise.resolve(true);
    },
  };
}
