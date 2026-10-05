// A master-key rotation in an order a crash cannot turn into data loss. The new key is STAGED at
// `<key>.next` (owner-only: 0600, and an ACL on Windows) before anything is sealed with it, the committed file is sealed second, and
// the rename that makes the new key live is last. Interrupted anywhere, some key on disk opens the
// committed file — and `recoverRotation`, which every `x secrets` command runs first, finishes or
// abandons the move by asking the file which key it answers to.

import { existsSync, readFileSync, rmSync } from 'node:fs'; // why: Bun has no sync exists/remove; the key is WRITTEN and RENAMED only by core's owner-only writers.
import type { MasterKeyRef, SecretValues } from '@ultimat3/core';
import {
  generateMasterKey,
  isUltimateError,
  masterKeyPath,
  promoteStagedMasterKey,
  readSecretsFile,
  stagedMasterKeyPath,
  stageMasterKeyFile,
  writeSecretsFile,
} from '@ultimat3/core';

const fileKey = (root: string, hex: string): MasterKeyRef => ({
  hex,
  source: 'file',
  at: masterKeyPath(root),
});

/** Stage, seal, then make live. Returns the key now in force. */
export async function rotateMasterKey(root: string, values: SecretValues): Promise<MasterKeyRef> {
  const hex = generateMasterKey();
  // A fresh temp file renamed over any leftover: a staged key left 0644 is replaced, never reused.
  stageMasterKeyFile(root, hex);
  const next = fileKey(root, hex);
  await writeSecretsFile(root, values, next);
  promoteStagedMasterKey(root);
  return next;
}

/**
 * A staged key left by an interrupted rotation: whichever of the two keys opens the committed file
 * is the live one. The staged key wins only by opening it, and is then moved into place; otherwise
 * it never sealed anything and is dropped. With no staged key this is `key`, unchanged.
 */
export async function recoverRotation(root: string, key: MasterKeyRef): Promise<MasterKeyRef> {
  const staged = stagedMasterKeyPath(root);
  if (!existsSync(staged)) return key;
  try {
    await readSecretsFile(root, key);
    rmSync(staged, { force: true });
    return key;
  } catch (error) {
    if (!isUltimateError(error) || error.code !== 'X_SECRETS_KEY_MISMATCH') throw error;
    const candidate = fileKey(root, readFileSync(staged, 'utf-8').trim());
    // Throws the staged key's own mismatch when neither opens it — the committed file's problem,
    // which `X_SECRETS_KEY_MISMATCH`'s fix (restore it from git) answers.
    await readSecretsFile(root, candidate);
    promoteStagedMasterKey(root);
    return candidate;
  }
}
