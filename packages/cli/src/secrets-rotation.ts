// A master-key rotation in an order a crash cannot turn into data loss. The new key is STAGED at
// `<key>.next` (0600) before anything is sealed with it, the committed file is sealed second, and
// the rename that makes the new key live is last. Interrupted anywhere, some key on disk opens the
// committed file — and `recoverRotation`, which every `x secrets` command runs first, finishes or
// abandons the move by asking the file which key it answers to.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'; // why: the staged key is written and renamed synchronously at 0600, and Bun has no mode-setting write or rename.
import type { MasterKeyRef, SecretValues } from '@ultimat3/core';
import {
  generateMasterKey,
  isUltimateError,
  masterKeyPath,
  readSecretsFile,
  SECRETS_KEY_MODE,
  stagedMasterKeyPath,
  writeSecretsFile,
} from '@ultimat3/core';

const fileKey = (root: string, hex: string): MasterKeyRef => ({
  hex,
  source: 'file',
  at: masterKeyPath(root),
});

/** Stage, seal, then make live. Returns the key now in force. */
export async function rotateMasterKey(root: string, values: SecretValues): Promise<MasterKeyRef> {
  const staged = stagedMasterKeyPath(root);
  const hex = generateMasterKey();
  rmSync(staged, { force: true });
  // `wx`: the mode applies only when a write CREATES the file, and a leftover could be 0644.
  writeFileSync(staged, `${hex}\n`, { encoding: 'utf-8', mode: SECRETS_KEY_MODE, flag: 'wx' });
  const next = fileKey(root, hex);
  await writeSecretsFile(root, values, next);
  renameSync(staged, masterKeyPath(root));
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
    renameSync(staged, masterKeyPath(root));
    return candidate;
  }
}
