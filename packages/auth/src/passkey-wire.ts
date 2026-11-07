// Single responsibility: the JSON shapes a passkey ceremony crosses the wire in — the options the
// server hands the browser and the credential the browser hands back — as TYPES only, so the
// browser entry (`client.ts`) and the server share one declaration and the client pays no bytes.
// Every binary field is base64url; the names are WebAuthn L3's `*JSON` dictionaries (§5.1.8).

export type PasskeyCredentialDescriptor = {
  readonly type: 'public-key';
  readonly id: string;
  readonly transports: readonly string[];
};

/** `PublicKeyCredentialCreationOptionsJSON`, as `passkeyLogin(auth).registerOptions` issues it. */
export type PasskeyCreationOptions = {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: 'none';
  readonly authenticatorSelection: {
    readonly residentKey: 'required';
    readonly requireResidentKey: true;
    readonly userVerification: 'required';
  };
  readonly excludeCredentials: readonly PasskeyCredentialDescriptor[];
};

/** `PublicKeyCredentialRequestOptionsJSON`, for sign-in and for step-up. */
export type PasskeyRequestOptions = {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: 'required';
  /** Empty for a usernameless sign-in; the user's own passkeys for a step-up. */
  readonly allowCredentials: readonly PasskeyCredentialDescriptor[];
};

/** `RegistrationResponseJSON`: what `newPasskey(options)` answers and `register` reads. */
export type PasskeyRegistrationResponse = {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports: readonly string[];
  };
};

/** `AuthenticationResponseJSON`: what `getPasskey(options)` answers and `login`/`verify` read. */
export type PasskeyAssertionResponse = {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle: string | null;
  };
};
