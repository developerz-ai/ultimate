// `@ultimat3/storage/adapter`: the `storage` port (`ADAPTER_PORTS`) as a driver author needs it —
// `StorageDriver` and the shapes it reads and answers, the errors a driver raises, and the helpers
// every driver must refuse with the same way. No installer: the boot READS `runtime.ts`'s `storage`
// driver as its default disk (`@ultimat3/cli`'s `runtime-storage-boot.ts`).

export type {
  ByteLimit,
  CopyOptions,
  ListOptions,
  PutOptions,
  ServerSideEncryption,
  SignedUrlMethod,
  SignedUrlOptions,
  StorageBody,
  StorageDriver,
  StorageListEntry,
  StorageObject,
  StorageRead,
  StreamOptions,
} from './driver';
export { assertPutOptions, etagOf, resolveListLimit, toBytes } from './driver';
export type { StorageErrorCode, StorageErrorInit } from './errors';
export {
  checksumMismatch,
  deleteFailed,
  getTooLarge,
  isStorageError,
  keyConflict,
  listFailed,
  objectNotFound,
  pathUnsafe,
  putFailed,
  putTooLarge,
  readFailed,
  StorageError,
} from './errors';
export type { MultipartCapability } from './multipart';
export type { ObjectLock, ObjectLockOptions } from './object-lock';
export type { PutStreamOptions } from './put-stream';
export type { ByteRange, GetOptions } from './range';
export type { SignedPart, SignedUrlVerification } from './signed-url';
