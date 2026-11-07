// Single responsibility: the screen over `defineAuth({ passkeys })` — the relying party a ceremony is
// bound to, judged at the seam BEFORE anything is built from it.
//
// Every rule below is a ceremony that would otherwise die in the browser with a `SecurityError` the
// server never sees: an rpId carrying a scheme never matches the `rpIdHash` an authenticator signs,
// and an origin the browser does not consider same-site yields a credential no RP can ever use.

import { renderCauseValue } from '@ultimat3/core';
import type { Auth, PasskeyConfig } from './auth';
import { AuthError } from './errors';

/** Loopback is the one place a browser itself allows an insecure origin. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
/** A bare host: labels of lower-case letters, digits and inner dashes; no trailing dot. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export const RPID_FIX =
  "passkeys: { rpId: 'example.com', origins: ['https://example.com'] }   # bare host: no scheme, port, path or trailing dot";
const ORIGINS_FIX =
  "passkeys: { rpId: 'example.com', origins: ['https://example.com'] }   # scheme and host only";

/** The seam's one refusal: `X_CONFIG_INVALID` naming the field, with a fix a paste can satisfy. */
export const passkeyConfigInvalid = (field: string, detail: string, fix: string): AuthError =>
  new AuthError({
    code: 'X_CONFIG_INVALID',
    cause: `defineAuth({ passkeys: { ${field} } }) ${detail}`,
    fix,
    meta: { option: `passkeys.${field}` },
  });

/**
 * Screen `passkeys`, answering the config everything else reads.
 *
 * An undeclared config answers the empty pair rather than throwing: an app that never opted into
 * passkeys must still boot. `passkeysOf` refuses that pair at the first use, with the same code.
 */
export function assertPasskeyConfig(input: PasskeyConfig | undefined): PasskeyConfig {
  if (input === undefined) return Object.freeze({ rpId: '', origins: Object.freeze([]) });
  const { rpId, origins } = input;
  if (typeof rpId !== 'string' || rpId === '') {
    throw passkeyConfigInvalid(
      'rpId',
      `needs a value, and ${renderCauseValue(rpId)} is not one: with no rpId no authenticator can hash one into the data it signs`,
      RPID_FIX,
    );
  }
  if (rpId !== rpId.toLowerCase()) {
    throw passkeyConfigInvalid(
      'rpId',
      `holds ${renderCauseValue(rpId)}, which is not lower case: a domain is case-insensitive, so a browser hashes a lower-cased value while this string is used verbatim`,
      "passkeys: { rpId: 'example.com' }   # lower-cased",
    );
  }
  if (!HOST_PATTERN.test(rpId) || rpId.endsWith('.')) {
    throw passkeyConfigInvalid(
      'rpId',
      `holds ${renderCauseValue(rpId)}, which is not a bare host: a scheme, port, path, trailing dot or space here can never equal the rpIdHash an authenticator signs`,
      RPID_FIX,
    );
  }
  if (!Array.isArray(origins) || origins.length === 0) {
    throw passkeyConfigInvalid(
      'origins',
      'is empty, so every ceremony is refused as a foreign origin — a browser sends the page origin and there would be nothing to compare it against',
      ORIGINS_FIX,
    );
  }
  const screened: string[] = [];
  for (const origin of origins) screened.push(screenOrigin(rpId, origin));
  return Object.freeze({ rpId, origins: Object.freeze(screened) });
}

/** One declared origin: absolute, https (http on loopback), and on the rpId or below it. */
function screenOrigin(rpId: string, origin: unknown): string {
  const detail = renderCauseValue(origin);
  if (typeof origin !== 'string') {
    throw passkeyConfigInvalid(
      'origins',
      `holds ${detail}, not a string, so no page origin could match it`,
      ORIGINS_FIX,
    );
  }
  // `new URL` throws a bare `TypeError` on garbage, and nothing but the config refusal may escape
  // `defineAuth` — so the parse itself sits behind a guard.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw passkeyConfigInvalid(
      'origins',
      `holds ${detail}, which is not an absolute URL`,
      ORIGINS_FIX,
    );
  }
  if (parsed.origin !== origin) {
    throw passkeyConfigInvalid(
      'origins',
      `holds ${detail}, which is not an origin: a path, query, fragment or trailing slash is not part of what a browser puts in clientDataJSON`,
      ORIGINS_FIX,
    );
  }
  const loopback = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw passkeyConfigInvalid(
      'origins',
      `holds ${detail}, whose scheme is ${parsed.protocol}: only https is acceptable (http for loopback, where a browser allows it)`,
      `passkeys: { rpId: '${rpId}', origins: ['https://${rpId}'] }   # https; http only for a loopback dev origin`,
    );
  }
  const host = parsed.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw passkeyConfigInvalid(
      'origins',
      `holds ${detail}, whose host is neither ${renderCauseValue(rpId)} nor a subdomain of it, so a browser refuses the ceremony before the server sees it`,
      `passkeys: { rpId: '${rpId}', origins: ['https://${rpId}'] }   # every origin sits on the rpId or below it`,
    );
  }
  return parsed.origin;
}

/** The config a ceremony reads, refused as a wiring fault when the app never declared one. */
export const passkeysOf = (auth: Auth): PasskeyConfig => {
  if (auth.passkeys.rpId === '' || auth.passkeys.origins.length === 0) {
    throw passkeyConfigInvalid(
      'rpId',
      'was never declared, so a WebAuthn ceremony has no relying party to bind a credential to',
      RPID_FIX,
    );
  }
  return auth.passkeys;
};
