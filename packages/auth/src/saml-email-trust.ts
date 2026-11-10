// Single responsibility: which asserted addresses a SAML IdP may vouch for. An IdP is one tenant's
// directory, and its admin can assert ANY address — so "trust this IdP's email" without a domain
// is "let one customer's admin sign in as another customer's verified user" (`resolveUser` links a
// verified provider address to the existing account). Trust is therefore per domain, exact.

import { renderCauseValue } from '@ultimat3/core';
import { AuthError } from './errors';

/** The trust half of `SamlIdentityProviderConfig`: `true` cannot be written without its domains. */
export type SamlEmailTrust =
  | {
      /** The IdP's addresses are never treated as verified: they cannot link or create accounts. */
      readonly trustEmail: false;
      readonly emailDomains?: undefined;
    }
  | {
      /** Addresses in `emailDomains` are verified; any other is not, and cannot link. */
      readonly trustEmail: true;
      /** The domains this IdP owns, exactly — a subdomain is listed on its own. Never empty. */
      readonly emailDomains: readonly string[];
    };

/** A DNS name: labels of letters, digits and inner hyphens. No wildcard, no trailing dot. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** The screened, lower-cased domain set; refuses at construction, never at the first login. */
export function samlTrustedDomains(provider: string, trust: SamlEmailTrust): ReadonlySet<string> {
  if (!trust.trustEmail) return new Set();
  const domains = (trust.emailDomains ?? []).map((domain) => domain.trim().toLowerCase());
  const bad = domains.find((domain) => !DOMAIN.test(domain));
  if (domains.length === 0 || bad !== undefined) {
    throw new AuthError({
      code: 'X_CONFIG_INVALID',
      cause:
        bad === undefined
          ? `samlIdentityProvider ${renderCauseValue(provider)} trusts asserted addresses with no emailDomains, so its admin could assert any tenant's address`
          : `samlIdentityProvider ${renderCauseValue(provider)} lists ${renderCauseValue(bad)} in emailDomains, which is not a plain domain`,
      fix: "samlIdentityProvider({ trustEmail: true, emailDomains: ['corp.example'] })  // the exact domains this IdP owns, or trustEmail: false",
      meta: { provider },
    });
  }
  return new Set(domains);
}

/** Whether `email`'s domain is one the IdP owns. Only the part after the LAST `@` is a domain. */
export function isTrustedAddress(email: string, domains: ReadonlySet<string>): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && domains.has(email.slice(at + 1).toLowerCase());
}
