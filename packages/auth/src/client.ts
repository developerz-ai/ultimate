// `@ultimat3/auth/client` — THE browser entry of this package: the passkey ceremony's browser half
// and the wire types it speaks, and nothing that drags the server half along. The `.` barrel
// reaches `@ultimat3/db`, argon2 and the error table; this entry's graph is `passkey-client.ts`
// and `base64url.ts`, held there by `client-bundle.test.ts`.
//
//   import { newPasskey, getPasskey } from '@ultimat3/auth/client';

export type { PasskeyClientHost, PasskeyOutcome } from './passkey-client';
export { getPasskey, newPasskey, passkeysSupported } from './passkey-client';
export type {
  PasskeyAssertionResponse,
  PasskeyCreationOptions,
  PasskeyCredentialDescriptor,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
} from './passkey-wire';
