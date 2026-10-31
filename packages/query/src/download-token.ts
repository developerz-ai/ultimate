/**
 * A download's `_token`: who the policy admitted, for which query and input, until when — SEALED
 * with core's `seal()` (AES-256-GCM under the master key, the query's name as the purpose).
 * Sealed, not signed: it carries the minting actor, and the AEAD tag is the signature.
 */

import type { Actor, ActorInit, ActorKind } from '@ultimat3/core';
import {
  agentActor,
  anonymousActor,
  fingerprint,
  isActorKind,
  isJsonObject,
  open,
  SealInvalidError,
  SealKeyUnknownError,
  seal,
  serviceActor,
  userActor,
} from '@ultimat3/core';
import {
  type DownloadTokenProblem,
  QueryDownloadTokenExpiredError,
  QueryDownloadTokenInvalidError,
} from './download-errors';

/** The search key the token rides under — `_`-prefixed like the page controls, so no input owns it. */
export const DOWNLOAD_GRANT_PARAM = '_token';

/** Bumped when the claims change shape: an old token is then refused, never misread. */
const TOKEN_VERSION = 1;

/**
 * The minting actor, minus `facts`. Facts are app values resolved per request — often not JSON at
 * all — so they are not carried: the policy decided WITH them at mint, and the handler runs under
 * the actor's identity, tenancy and grants.
 */
interface ReplayActor {
  readonly k: ActorKind;
  readonly i: string;
  readonly o?: string;
  readonly r: readonly string[];
  readonly s: readonly string[];
  readonly p: readonly string[];
  readonly b?: { readonly actorId: string; readonly actorKind: ActorKind };
  readonly l?: string;
  readonly z?: string;
}

interface Claims {
  readonly v: number;
  /** The query's name — also the seal's purpose, and checked again here. */
  readonly q: string;
  /** `fingerprint()` of the PARSED input: a URL whose input was edited no longer matches. */
  readonly f: string;
  /** Expiry, epoch milliseconds, on the context's clock. */
  readonly e: number;
  readonly a: ReplayActor;
}

const purposeOf = (query: string): string => `ultimate.query.download:${query}`;

function replayOf(actor: Actor): ReplayActor {
  return {
    k: actor.kind,
    i: actor.id,
    ...(actor.orgId === undefined ? {} : { o: actor.orgId }),
    r: actor.roles,
    s: actor.scopes,
    p: actor.permissions,
    ...(actor.onBehalfOf === undefined ? {} : { b: actor.onBehalfOf }),
    ...(actor.locale === undefined ? {} : { l: actor.locale }),
    ...(actor.tz === undefined ? {} : { z: actor.tz }),
  };
}

/** Seal the claims for one admitted call. `input` is the PARSED input the policy decided about. */
export function mintDownloadToken(
  query: string,
  input: unknown,
  actor: Actor,
  expiresAtMs: number,
): Promise<string> {
  const claims: Claims = {
    v: TOKEN_VERSION,
    q: query,
    f: fingerprint(input),
    e: expiresAtMs,
    a: replayOf(actor),
  };
  return seal(JSON.stringify(claims), { purpose: purposeOf(query) });
}

/** What an opened token grants: the actor to run as, and the input it was minted for. */
export interface DownloadGrant {
  readonly actor: Actor;
  /** `fingerprint()` of the parsed input the policy admitted. */
  readonly input: string;
}

/**
 * The grant a token carries — or a refusal, in the order `@ultimat3/storage` checks a signed URL
 * in: the seal (forged, truncated, another query's, a retired key) BEFORE the expiry, so an
 * expired forgery is answered as a forgery. Opened BEFORE the input is parsed, so a holder of no
 * genuine token learns nothing about the read's schema from an `X_INPUT_INVALID`.
 */
export async function openDownloadToken(
  query: string,
  token: string,
  nowMs: number,
): Promise<DownloadGrant> {
  const claims = await claimsOf(query, token);
  if (claims.e <= nowMs) {
    throw new QueryDownloadTokenExpiredError(query, new Date(claims.e).toISOString());
  }
  return { actor: actorOf(query, claims.a), input: claims.f };
}

/** The URL's parsed input against the one the token was minted for: an edited URL is refused. */
export function assertGrantedInput(query: string, grant: DownloadGrant, input: unknown): void {
  if (grant.input !== fingerprint(input)) throw refused(query, 'other-input');
}

const refused = (query: string, problem: DownloadTokenProblem): QueryDownloadTokenInvalidError =>
  new QueryDownloadTokenInvalidError(query, problem);

async function claimsOf(query: string, token: string): Promise<Claims> {
  let text: string;
  try {
    text = new TextDecoder().decode(await open(token, { purpose: purposeOf(query) }));
  } catch (error) {
    // A tag that does not verify, a string that is no sealed value, or a key this process no
    // longer declares: every one is "not a token this app can honour". A MISSING master key is
    // the server's fault, not the URL's, and keeps its own code (`X_SEAL_KEY_MISSING`, a 500).
    if (error instanceof SealInvalidError || error instanceof SealKeyUnknownError) {
      throw refused(query, error instanceof SealKeyUnknownError ? 'unauthenticated' : 'malformed');
    }
    throw error;
  }
  const claims = parseClaims(text);
  if (claims === undefined) throw refused(query, 'malformed');
  if (claims.q !== query) throw refused(query, 'other-query');
  return claims;
}

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The claims, or `undefined` for any shape this version did not write. Rebuilt, never cast. */
function parseClaims(text: string): Claims | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(raw) || raw['v'] !== TOKEN_VERSION) return undefined;
  const { q, f, e } = raw;
  if (typeof q !== 'string' || typeof f !== 'string') return undefined;
  if (typeof e !== 'number' || !Number.isSafeInteger(e)) return undefined;
  const a = replayFrom(raw['a']);
  return a === undefined ? undefined : { v: TOKEN_VERSION, q, f, e, a };
}

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

function replayFrom(a: unknown): ReplayActor | undefined {
  if (!isJsonObject(a)) return undefined;
  const { k, i, o, r, s, p, b, l, z } = a;
  if (!isActorKind(k) || typeof i !== 'string') return undefined;
  if (!isStrings(r) || !isStrings(s) || !isStrings(p)) return undefined;
  if (!optionalText(o) || !optionalText(l) || !optionalText(z)) return undefined;
  let behalf: ReplayActor['b'];
  if (b !== undefined) {
    if (!isJsonObject(b)) return undefined;
    const { actorId, actorKind } = b;
    if (typeof actorId !== 'string' || !isActorKind(actorKind)) return undefined;
    behalf = { actorId, actorKind };
  }
  return {
    k,
    i,
    r,
    s,
    p,
    ...(o === undefined ? {} : { o }),
    ...(behalf === undefined ? {} : { b: behalf }),
    ...(l === undefined ? {} : { l }),
    ...(z === undefined ? {} : { z }),
  };
}

function actorOf(query: string, replay: ReplayActor): Actor {
  if (replay.k === 'anonymous') return anonymousActor();
  const init: ActorInit = {
    id: replay.i,
    orgId: replay.o,
    roles: replay.r,
    scopes: replay.s,
    permissions: replay.p,
    onBehalfOf: replay.b,
    locale: replay.l,
    tz: replay.z,
  };
  switch (replay.k) {
    case 'user':
      return userActor(init);
    case 'service':
      return serviceActor(init);
    case 'agent':
      return agentActor(init);
    default:
      throw refused(query, 'malformed');
  }
}
