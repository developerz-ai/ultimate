// `@ultimat3/storage/adapter`: two ports as an adapter author needs them. `storage`: `StorageDriver`,
// its shapes, errors and shared refusal helpers — no installer, the boot READS `runtime.ts`'s
// driver as its default disk (`@ultimat3/cli`'s `runtime-storage-boot.ts`). `uploadScanner`:
// `UploadScanner`, what it is asked and answers, and the boot's installer.

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
export type { LocalDriverOptions } from './driver-local';
export type { MemoryStorageDriverOptions } from './driver-memory';
export type { S3DriverOptions } from './driver-s3';
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
export type { ScanInput, ScanVerdict, UploadScanner } from './upload-scanner';
export { installUploadScanner, resetUploadScanner } from './upload-scanner';
