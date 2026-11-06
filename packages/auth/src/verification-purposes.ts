// Single responsibility: the one registry of verification purposes — a name, the mail template it
// sends, how long its token lives and how its identifier is keyed. Open, not an enum: an invite or
// an account deletion is the same single-use mailed credential as a reset, so it is declared here
// once (`defineVerificationPurpose`, `verify.ts`) instead of hand-rolling hashing and compare again.

import { renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import { AuthError } from './errors';

export interface VerificationPurposeDef {
  readonly name: string;
  /** A catalog key, not copy: the body lives in the app's i18n catalog. */
  readonly template: string;
  readonly ttlMs: number;
  /** How the identifier becomes the store key and the mail address. */
  readonly identifier: (raw: string) => string;
}

// A Map, never a record keyed by an attacker-reachable string: `consumeVerification` looks a
// purpose up by whatever name its caller passed, and `__proto__` on an object is not "undeclared".
const purposes = new Map<string, VerificationPurposeDef>();

const purposeInvalid = (cause: string, fix: string): AuthError =>
  new AuthError({ code: 'X_VERIFICATION_PURPOSE_INVALID', cause, fix });

/** At boot. A second declaration under one name is refused: two templates for one link. */
export function registerVerificationPurpose(def: VerificationPurposeDef): void {
  if (def.name.trim() === '' || def.name !== def.name.trim()) {
    throw purposeInvalid(
      `defineVerificationPurpose() was handed the name ${renderCauseValue(def.name)}, which is empty or padded`,
      "defineVerificationPurpose({ name: 'member-invite', template, ttlMs })   # a non-empty, unpadded name",
    );
  }
  if (def.template.trim() === '') {
    throw purposeInvalid(
      `defineVerificationPurpose({ name: '${def.name}' }) has no template, so its token could not be mailed`,
      `defineVerificationPurpose({ name: '${def.name}', template: 'auth.${def.name}', ttlMs })   # and add the key to your i18n catalog`,
    );
  }
  if (purposes.has(def.name)) {
    throw purposeInvalid(
      `the verification purpose '${def.name}' is declared twice, so which template and lifetime it has depends on import order`,
      `defineVerificationPurpose({ name: '<another-name>', template, ttlMs })   # rename one of the two '${def.name}' declarations, or import the first`,
    );
  }
  purposes.set(def.name, def);
}

/** The declared purpose, or the 400 an undeclared one is. Never a default. */
export function verificationPurpose(name: string): VerificationPurposeDef {
  const def = purposes.get(name);
  if (def !== undefined) return def;
  throw new AuthError({
    code: 'X_VERIFICATION_PURPOSE_UNKNOWN',
    // The name may be a request field: rendered as a literal, so it cannot forge a log line.
    cause: `no verification purpose named ${renderCauseValue(name)} is declared`,
    fix: `defineVerificationPurpose({ name: ${renderFixLiteral(name, "'<purpose>'")}, template: 'auth.<purpose>', ttlMs })   # once, at boot`,
  });
}

/** Every declared name, for a test or `x doctor` to list. */
export const verificationPurposeNames = (): readonly string[] => [...purposes.keys()];
