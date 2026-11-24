// Single responsibility: a virtual WebAuthn authenticator on one tab (CDP's `WebAuthn` domain), so a
// passkey registration and sign-in run end to end in the e2e harness with no device: the page's own
// `navigator.credentials.create/get` is answered by it, user presence and verification included.

import type { E2eTab } from './cdp-e2e-page';
import { tabPortOf } from './cdp-ports';

/** What the authenticator is. The defaults are a platform passkey: resident key, user verified. */
export interface VirtualAuthenticatorOptions {
  /** Default `'internal'` — a platform authenticator, as a laptop's or a phone's. */
  readonly transport?: 'internal' | 'usb' | 'nfc' | 'ble' | undefined;
  /** Default `true`: discoverable credentials, what a usernameless sign-in needs. */
  readonly residentKey?: boolean | undefined;
  /** Default `true`: the person passes the PIN or biometric. `false` answers every UV as failed. */
  readonly userVerified?: boolean | undefined;
}

/** One credential the authenticator holds, as CDP reports it. */
export interface VirtualCredential {
  /** base64 of the raw credential id. */
  readonly credentialId: string;
  readonly rpId: string;
  readonly resident: boolean;
  readonly signCount: number;
  /** base64 of the user handle the relying party registered; absent for a non-resident one. */
  readonly userHandle: string | undefined;
}

export interface VirtualAuthenticator {
  readonly id: string;
  /** Every credential registered on it, in the order the browser lists them. */
  credentials(): Promise<readonly VirtualCredential[]>;
  /** The person's verification from here on: `false` makes the next ceremony fail UV. */
  setUserVerified(verified: boolean): Promise<void>;
  /** Detaches this authenticator only: another added to the same tab keeps answering ceremonies. */
  remove(): Promise<void>;
}

const field = (from: unknown, key: string): unknown =>
  typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;

const toCredential = (raw: unknown): VirtualCredential => {
  const handle = field(raw, 'userHandle');
  return {
    credentialId: String(field(raw, 'credentialId') ?? ''),
    rpId: String(field(raw, 'rpId') ?? ''),
    resident: field(raw, 'isResidentCredential') === true,
    signCount: Number(field(raw, 'signCount') ?? 0),
    userHandle: typeof handle === 'string' ? handle : undefined,
  };
};

/**
 * Adds a CTAP2 authenticator to `tab` with presence simulated, so a ceremony completes with no
 * prompt. Per tab: another tab, or another context's, has none until it is given one.
 */
export async function addVirtualAuthenticator(
  tab: E2eTab,
  options: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const { connection, sessionId } = tabPortOf(tab, 'addVirtualAuthenticator');
  const send = (method: string, params: Record<string, unknown> = {}) =>
    connection.send(method, params, sessionId);
  await send('WebAuthn.enable', { enableUI: false });
  const added = await send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: options.transport ?? 'internal',
      hasResidentKey: options.residentKey ?? true,
      hasUserVerification: true,
      isUserVerified: options.userVerified ?? true,
      automaticPresenceSimulation: true,
    },
  });
  const id = String(field(added.result, 'authenticatorId') ?? '');
  return {
    id,
    async credentials() {
      const listed = await send('WebAuthn.getCredentials', { authenticatorId: id });
      const raw = field(listed.result, 'credentials');
      return Array.isArray(raw) ? raw.map(toCredential) : [];
    },
    async setUserVerified(verified) {
      await send('WebAuthn.setUserVerified', { authenticatorId: id, isUserVerified: verified });
    },
    async remove() {
      await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id });
    },
  };
}
