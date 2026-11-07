// Single responsibility: the BROWSER half of a passkey ceremony — the server's JSON options into
// `navigator.credentials.create/get`, and the credential back out as JSON for the app's action.
// Imports only `base64url.ts` and types, so an island offering "Sign in with a passkey" pays for
// these lines and nothing of the server package (`@ultimat3/auth/client`, `client-bundle.test.ts`).
//
//   const options = await client.passkeyLoginOptions({});
//   const outcome = await getPasskey(options);
//   if (outcome.status === 'ok') await client.passkeySignIn({ response: outcome.response });

import { base64Url, canonicalBase64UrlBytes } from './base64url';
import type {
  PasskeyAssertionResponse,
  PasskeyCreationOptions,
  PasskeyCredentialDescriptor,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
} from './passkey-wire';

/**
 * Every branch is an outcome to render, never an exception: `cancelled` is the person's choice
 * (or the timeout), `unsupported` the browser's, `failed` anything else, named by the DOM error.
 */
export type PasskeyOutcome<T> =
  | { readonly status: 'ok'; readonly response: T }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly error: string };

/** The browser surface this touches — injectable, so a test runs a ceremony without a browser. */
export interface PasskeyClientHost {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

const browserHost = (): PasskeyClientHost | null => {
  const container = globalThis.navigator?.credentials;
  return container === undefined || globalThis.PublicKeyCredential === undefined ? null : container;
};

/** Whether this browser can run a ceremony at all — for hiding the button, not for security. */
export const passkeysSupported = (): boolean => browserHost() !== null;

const bytes = (field: string): Uint8Array<ArrayBuffer> =>
  canonicalBase64UrlBytes(field) ?? new Uint8Array();

const TRANSPORTS: ReadonlySet<string> = new Set([
  'usb',
  'nfc',
  'ble',
  'smart-card',
  'hybrid',
  'internal',
]);
const isTransport = (value: string): value is AuthenticatorTransport => TRANSPORTS.has(value);

const descriptor = (row: PasskeyCredentialDescriptor): PublicKeyCredentialDescriptor => ({
  type: 'public-key',
  id: bytes(row.id),
  transports: row.transports.filter(isTransport),
});

const text = (buffer: ArrayBuffer | null | undefined): string =>
  buffer === null || buffer === undefined ? '' : base64Url(new Uint8Array(buffer));

/** Structural, not `instanceof`: a test host (and a polyfill) has no `PublicKeyCredential` class. */
const isPublicKey = (credential: Credential | null): credential is PublicKeyCredential =>
  credential !== null &&
  credential.type === 'public-key' &&
  'rawId' in credential &&
  credential.rawId instanceof ArrayBuffer &&
  'response' in credential;

const outcomeOf = (error: unknown): PasskeyOutcome<never> => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : 'Error';
  // `NotAllowedError` is what every browser answers for "the person closed the sheet" and for the
  // timeout alike, deliberately indistinguishable (§13.4.7); `AbortError` is the page's own abort.
  if (name === 'NotAllowedError' || name === 'AbortError') return { status: 'cancelled' };
  return { status: 'failed', error: name };
};

/** Registration: `passkeyLogin(auth).registerOptions` in, `register`'s `response` out. */
export async function newPasskey(
  options: PasskeyCreationOptions,
  host: PasskeyClientHost | null = browserHost(),
): Promise<PasskeyOutcome<PasskeyRegistrationResponse>> {
  if (host === null) return { status: 'unsupported' };
  try {
    const credential = await host.create({
      publicKey: {
        challenge: bytes(options.challenge),
        rp: options.rp,
        user: { ...options.user, id: bytes(options.user.id) },
        pubKeyCredParams: [...options.pubKeyCredParams],
        timeout: options.timeout,
        attestation: options.attestation,
        authenticatorSelection: options.authenticatorSelection,
        excludeCredentials: options.excludeCredentials.map(descriptor),
      },
    });
    if (!isPublicKey(credential)) return { status: 'failed', error: 'NoCredential' };
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      status: 'ok',
      response: {
        id: credential.id,
        rawId: text(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: text(response.clientDataJSON),
          attestationObject: text(response.attestationObject),
          transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
      },
    };
  } catch (error) {
    return outcomeOf(error);
  }
}

/** Sign-in and step-up: `loginOptions` / `stepUp.options` in, `login` / `verify`'s `response` out. */
export async function getPasskey(
  options: PasskeyRequestOptions,
  host: PasskeyClientHost | null = browserHost(),
): Promise<PasskeyOutcome<PasskeyAssertionResponse>> {
  if (host === null) return { status: 'unsupported' };
  try {
    const credential = await host.get({
      publicKey: {
        challenge: bytes(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: options.allowCredentials.map(descriptor),
      },
    });
    if (!isPublicKey(credential)) return { status: 'failed', error: 'NoCredential' };
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      status: 'ok',
      response: {
        id: credential.id,
        rawId: text(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: text(response.clientDataJSON),
          authenticatorData: text(response.authenticatorData),
          signature: text(response.signature),
          userHandle: response.userHandle === null ? null : text(response.userHandle),
        },
      },
    };
  } catch (error) {
    return outcomeOf(error);
  }
}
