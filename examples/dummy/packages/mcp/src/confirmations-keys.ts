/**
 * The keys Postly's approvers sign agent publishes with — `mcpConfirmations({ evidence })`'s
 * `verify`, for `./confirmations.ts`. Each member who may approve registers one or more Ed25519
 * public keys (raw, base64url) under their member id in `POSTLY_APPROVER_KEYS`:
 * `{ "<member id>": ["<key>", …] }`. Several per member, so a key rotates by adding the new one
 * before removing the old. Read per verification, so a deploy that rotates the secret needs no
 * restart and a verifier running in another process reads the same registry.
 *
 * The private half never touches the server: the approver's device signs the `signingPayload` the
 * decision's `view` returns. A compromised app server can therefore store no vote this verifies.
 */

import { type McpEvidenceCheck, t } from '@ultimat3/mcp';

/** The env key, declared at its point of use — the rule `app.config.ts` states for app-only keys. */
export const APPROVER_KEYS_ENV = 'POSTLY_APPROVER_KEYS';

/** Bounded: 43 characters is one raw Ed25519 key; a registry is a handful per member. */
const registry = t.record(t.array(t.string.max(64), { max: 8 }));

/** The public keys registered to `approver`, none when the registry is unset or names them not. */
export function approverKeys(
  approver: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): readonly string[] {
  const raw = env[APPROVER_KEYS_ENV];
  if (raw === undefined || raw.length === 0) return [];
  // A registry that is not this shape refuses with the schema's own code: a typo in a deploy
  // secret is an outage to fix, never a silent "nobody may approve".
  let decoded: unknown = raw;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // Not JSON: the schema below then refuses the text itself, with its own code and path.
  }
  const keys = new Map(Object.entries(registry.parse(decoded, APPROVER_KEYS_ENV)));
  return keys.get(approver) ?? [];
}

const bytesOf = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.fromBase64(text, { alphabet: 'base64url' });

/** `true` only when the signature verifies over the payload under one of the approver's keys. */
export async function verifyApproverSignature(check: McpEvidenceCheck): Promise<boolean> {
  const message = new TextEncoder().encode(check.payload);
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = bytesOf(check.signature);
  } catch {
    // The signature is the approver's input: one that is not base64url verifies as nothing.
    return false;
  }
  for (const encoded of approverKeys(check.approver)) {
    const key = await crypto.subtle.importKey('raw', bytesOf(encoded), 'Ed25519', false, [
      'verify',
    ]);
    if (await crypto.subtle.verify('Ed25519', key, signature, message)) return true;
  }
  return false;
}
