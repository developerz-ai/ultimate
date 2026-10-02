// Single responsibility: the key ring `seal()` and `open()` work under. The CURRENT key is the one
// `x secrets` already manages — `ULTIMATE_SECRETS_KEY` first, `.secrets.key` second, through
// `findMasterKey`, no second variable. RETIRED keys are one more env var, which `x secrets rotate`
// writes into the committed file and `installSecrets()` carries into the process like any secret.

import { SealKeyMissingError } from './seal-errors';
import { importKey, masterKeyId, parseMasterKey } from './secrets';
import { findMasterKey, masterKeyPath, SECRETS_KEY_ENV } from './secrets-store';

/**
 * Master keys that no longer seal but still open: 64 hex characters each, separated by commas or
 * whitespace. A secret like any other — it lives in `secrets.enc.json` under this name, sealed by
 * the current key, so a deploy is handed ONE key and the ring travels in the repository.
 */
export const SECRETS_RETIRED_KEYS_ENV = 'ULTIMATE_SECRETS_RETIRED_KEYS';

type EnvRecord = Record<string, string | undefined>;

/** Where the keys are read from. The same two fields, with the same defaults, as `installSecrets`. */
export interface SealKeySource {
  /** The app root holding `.secrets.key`. Defaults to the process's working directory. */
  readonly root?: string | undefined;
  /** Read for the current key and the retired ring. Defaults to `process.env`. */
  readonly env?: EnvRecord | undefined;
}

export interface SealKey {
  /** `masterKeyId`'s — the id a sealed string carries. */
  readonly id: string;
  readonly aes: CryptoKey;
  /** HMAC key the deterministic IV is derived under; never the AES key itself. */
  readonly mac: CryptoKey;
}

export interface SealKeyRing {
  readonly current: SealKey;
  /** Current first, then retired in declaration order. */
  readonly keys: readonly SealKey[];
  /** The same keys by the id a sealed string names — built once, read on every `open()`. */
  readonly byId: ReadonlyMap<string, SealKey>;
}

const encoder = new TextEncoder();
const MAC_DOMAIN = encoder.encode('ultimate.seal.iv.v1');

/**
 * The MAC key is DERIVED from the master key under a fixed label rather than being the master key:
 * one key used for both AES-GCM and HMAC has no known break, and no proof either.
 */
async function sealKey(hex: string, at: string, variable?: string): Promise<SealKey> {
  const raw = parseMasterKey(hex, at, variable);
  const hmac = { name: 'HMAC', hash: 'SHA-256' } as const;
  const master = await crypto.subtle.importKey('raw', raw, hmac, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', master, MAC_DOMAIN);
  return {
    id: await masterKeyId(raw),
    aes: await importKey(raw),
    mac: await crypto.subtle.importKey('raw', derived, hmac, false, ['sign']),
  };
}

/** The retired ring as written: hex entries, in order, blanks dropped. Nothing is validated here. */
export function splitRetiredKeys(raw: string | undefined): readonly string[] {
  return (raw ?? '').split(/[\s,]+/).filter((entry) => entry.length > 0);
}

async function buildRing(
  current: string,
  currentAt: string,
  retired: string,
): Promise<SealKeyRing> {
  const first = await sealKey(current, currentAt);
  const keys = [first];
  for (const [index, hex] of splitRetiredKeys(retired).entries()) {
    // A malformed entry is refused by position, never skipped: a ring that silently lost a key
    // surfaces later as X_SEAL_KEY_UNKNOWN on a row, far from the edit that caused it.
    const next = await sealKey(
      hex,
      `${SECRETS_RETIRED_KEYS_ENV} (entry ${index + 1})`,
      SECRETS_RETIRED_KEYS_ENV,
    );
    if (!keys.some((key) => key.id === next.id)) keys.push(next);
  }
  return { current: first, keys, byId: new Map(keys.map((key) => [key.id, key])) };
}

// The last ring, kept by the exact strings it was built from. Importing a key is three WebCrypto
// calls and a list read opens hundreds of values, so the ring is built once — but it is keyed by
// its SOURCE, never by time or by process, so a rotated key file or a changed variable is a new
// ring on the very next call. Only a resolved ring is kept; a refusal is recomputed.
let memo: { readonly source: string; readonly ring: Promise<SealKeyRing> } | undefined;

/** The ring in force now, or `X_SEAL_KEY_MISSING`. A malformed key is `X_SECRETS_KEY_INVALID`. */
export function resolveSealKeys(source: SealKeySource = {}): Promise<SealKeyRing> {
  const root = source.root ?? process.cwd();
  const env = source.env ?? (process.env as EnvRecord);
  const found = findMasterKey(root, env);
  if (found === undefined) {
    return Promise.reject(
      new SealKeyMissingError({ envVar: SECRETS_KEY_ENV, keyPath: masterKeyPath(root) }),
    );
  }
  const retired = env[SECRETS_RETIRED_KEYS_ENV] ?? '';
  const key = `${found.hex}\n${retired}`;
  if (memo?.source === key) return memo.ring;
  const ring = buildRing(found.hex, found.at, retired);
  const entry = { source: key, ring };
  memo = entry;
  ring.catch(() => {
    if (memo === entry) memo = undefined;
  });
  return ring;
}

/** The ids a sealed value may name right now. Safe to print: an id is not a key. */
export async function sealKeyIds(
  source: SealKeySource = {},
): Promise<{ readonly current: string; readonly retired: readonly string[] }> {
  const ring = await resolveSealKeys(source);
  return { current: ring.current.id, retired: ring.keys.slice(1).map((key) => key.id) };
}
