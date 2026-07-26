// The X_* codes owned by @ultimat3/storage. Every `fix` is an exact edit or command: a
// rejected upload must tell the caller which constraint fired and where that constraint is
// configured, or the caller retries the same bytes forever.

import { errorDocsUrl, hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const STORAGE_ERROR_CODES = [
  'X_STORAGE_DISK_UNKNOWN',
  'X_STORAGE_NOT_FOUND',
  'X_STORAGE_PATH_UNSAFE',
  'X_STORAGE_TOO_LARGE',
  'X_STORAGE_TYPE_REJECTED',
  'X_STORAGE_CHECKSUM_MISMATCH',
  'X_NOT_IMPLEMENTED',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export const STORAGE_ERROR_TITLES: Readonly<Record<StorageErrorCode, string>> = {
  X_STORAGE_DISK_UNKNOWN: 'no disk with that name is configured',
  X_STORAGE_NOT_FOUND: 'no object at that key',
  X_STORAGE_PATH_UNSAFE: 'object key escapes its prefix',
  X_STORAGE_TOO_LARGE: 'payload exceeds the upload size limit',
  X_STORAGE_TYPE_REJECTED: 'content type is not allowed for this upload',
  X_STORAGE_CHECKSUM_MISMATCH: 'bytes do not match the declared checksum',
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
};

// Titles must be registered for `format()` to render the contract's first line, but
// `X_NOT_IMPLEMENTED` belongs to core — registering a code twice throws X_ERROR_CODE_DUPLICATE.
for (const [code, title] of Object.entries(STORAGE_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

export interface StorageErrorInit {
  readonly code: StorageErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export class StorageError extends UltimateError {
  override readonly name = 'StorageError';

  constructor(init: StorageErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: errorDocsUrl(init.code),
      meta: init.meta,
    });
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

export const diskUnknown = (name: string, configured: readonly string[]): StorageError =>
  new StorageError({
    code: 'X_STORAGE_DISK_UNKNOWN',
    cause: `no disk named "${name}" (configured: ${
      configured.length > 0 ? configured.join(', ') : 'none'
    })`,
    fix: `add "${name}" to storage.disks in app.config.ts, or call disk('${
      configured[0] ?? 'local'
    }')`,
    meta: { name, configured },
  });

export const objectNotFound = (disk: string, key: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_NOT_FOUND',
    cause: `disk "${disk}" has no object at "${key}"`,
    fix: `x storage ls ${disk} --prefix ${key.split('/').slice(0, -1).join('/')} --json`,
    meta: { disk, key },
  });

export const pathUnsafe = (key: string, reason: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_PATH_UNSAFE',
    cause: `key ${JSON.stringify(key)} ${reason}`,
    fix: 'build the key with scopedKey(orgId, ...parts) — relative, forward slashes, no ".."',
    meta: { key, reason },
  });

export const tooLarge = (key: string, bytes: number, maxBytes: number): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `"${key}" is ${bytes}B, over the policy limit of ${maxBytes}B`,
    fix: `raise maxBytes in the upload policy (uploadPolicy({ maxBytes: ${bytes} })), or compress the file first`,
    meta: { key, bytes, maxBytes },
  });

/** The declared type is not on the allowlist at all. */
export const contentTypeNotAllowed = (
  key: string,
  declared: string,
  allowed: readonly string[],
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared}, which is not in the policy allowlist (${allowed.join(', ')})`,
    fix: `add '${declared}' to allowedContentTypes in the upload policy, or upload one of: ${allowed.join(', ')}`,
    meta: { key, declared, allowed },
  });

/** The bytes say one thing and the client said another — the bytes win. */
export const contentTypeMismatch = (key: string, declared: string, sniffed: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared} but its magic bytes are ${sniffed}`,
    fix: `re-upload with Content-Type: ${sniffed}, or upload a genuine ${declared} file`,
    meta: { key, declared, sniffed },
  });

export const checksumMismatch = (key: string, declared: string, actual: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_CHECKSUM_MISMATCH',
    cause: `"${key}" declared sha256 ${declared} but the bytes hash to ${actual}`,
    fix: 'recompute the checksum over the exact bytes you send, or omit it and let the driver hash',
    meta: { key, declared, actual },
  });

/** An interface-complete driver whose remote half is not bound yet. Always carries a fix. */
export const storageNotImplemented = (feature: string, fix: string): StorageError =>
  new StorageError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is declared but not implemented in @ultimat3/storage`,
    fix,
    meta: { feature },
  });
