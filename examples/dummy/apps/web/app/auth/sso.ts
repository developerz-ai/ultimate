/**
 * Single sign-on for an org whose people live in a corporate directory: one SAML identity provider
 * beside "log in with GitHub" (`./login.ts`), on the same `/auth/sso/:provider` legs, the same
 * sealed state and the same session. Signature, audience, replay and XML hardening are
 * `@ultimat3/auth`'s; this file holds the three decisions that are Postly's — the provider's id,
 * which email domains its directory may vouch for, and where a signed-in member lands.
 *
 * The IdP is configuration, never code: its metadata XML and its domains are secrets of the deploy
 * (`x secrets set POSTLY_SSO_IDP_METADATA …`). Unset, nothing is mounted and `/auth/sso/corp` is
 * the router's 404 — a provider nobody configured is not a half-working redirect. What mounts it is
 * `./sso-routes.ts`; this file builds nothing at import.
 */

import type { Auth, IdentityProviderRoutes, IdentityProviderRoutesOptions } from '@ultimat3/auth';
import { identityProviderRoutes, parseSamlMetadata, samlIdentityProvider } from '@ultimat3/auth';
import { appOrigin } from '../../shared/app-origin';
import { AFTER_SIGN_IN, SSO_PROVIDER } from './sign-in-paths';

export interface PostlySsoConfig {
  /** The IdP's metadata document, as its admin console exports it. Its keys are the only trust. */
  readonly idpMetadataXml: string;
  /** The domains that directory owns, exactly: an address outside them can neither link nor sign up. */
  readonly emailDomains: readonly string[];
}

/** What the IdP is registered with: Postly's SP entity id, one per origin. */
export const spEntityId = (origin: string = appOrigin()): string => `${origin}/saml/metadata`;

/**
 * The deploy's IdP, or `null` when none is configured. Both variables or neither: metadata without
 * domains would be an IdP whose addresses Postly trusts for no one, which is a misconfiguration.
 */
export function ssoConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): PostlySsoConfig | null {
  const idpMetadataXml = env['POSTLY_SSO_IDP_METADATA'] ?? '';
  const emailDomains = (env['POSTLY_SSO_EMAIL_DOMAINS'] ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');
  if (idpMetadataXml === '' && emailDomains.length === 0) return null;
  // One of the two alone reaches `samlIdentityProvider`, which refuses it with its own code.
  return { idpMetadataXml, emailDomains };
}

/**
 * The SSO legs as route descriptors. `options` carries the seams a test drives (the origin, the
 * state secret); the landing path is applied after them, so no caller can move it.
 */
export function postlySso(
  auth: Auth,
  config: PostlySsoConfig,
  options: Omit<IdentityProviderRoutesOptions, 'providers' | 'successPath' | 'resolveGrants'> = {},
): IdentityProviderRoutes {
  const provider = samlIdentityProvider({
    id: SSO_PROVIDER,
    idp: parseSamlMetadata(config.idpMetadataXml),
    spEntityId: spEntityId(options.baseUrl),
    trustEmail: true,
    emailDomains: config.emailDomains,
  });
  return identityProviderRoutes(auth, {
    ...options,
    providers: [provider],
    successPath: AFTER_SIGN_IN,
  });
}
