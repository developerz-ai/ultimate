// Single responsibility: the public API of @ultimat3/storage. Explicit named exports only —
// every consumer imports from here, so this list is the package's contract.

export type { AcceptSignedUploadInput, SignedRequestInput } from './accept';
export { acceptSignedUpload, readSignedObject, signedUploadConstraints } from './accept';
export type {
  AttachmentTarget,
  PromoteAttachmentInput,
  ReleaseQuarantineInput,
  SweepFailure,
  SweepOrphansInput,
  SweepResult,
} from './attachment';
export {
  attachmentKey,
  attachmentPrefix,
  isPendingKey,
  isQuarantinedKey,
  PENDING_SEGMENT,
  pendingKey,
  pendingPrefix,
  promoteAttachment,
  QUARANTINE_SEGMENT,
  quarantineKey,
  quarantinePrefix,
  releaseQuarantine,
  sweepOrphans,
  uploadExtension,
  uploadName,
} from './attachment';
export type {
  ByteLimit,
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
} from './driver';
export {
  // Exported for the same reason `toBytes` is: a driver written outside this package has to
  // refuse a `limit` the same way both shipped ones do, or it is a third answer to one question.
  assertPutOptions,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT,
  etagOf,
  resolveListLimit,
  sha256Base64,
  toBytes,
} from './driver';
export type { LocalDriverOptions } from './driver-local';
export { localDriver } from './driver-local';
export type { MemoryStorageDriver, MemoryStorageDriverOptions } from './driver-memory';
export { memoryStorageDriver } from './driver-memory';
export type { S3DriverOptions } from './driver-s3';
export { s3Driver } from './driver-s3';
export type {
  S3ClientLike,
  S3FileLike,
  S3ListEntryLike,
  S3ListResultLike,
  S3StatLike,
} from './driver-s3-client';
export type { S3FetchLike } from './driver-s3-signed';
export type { StorageErrorCode, StorageErrorInit } from './errors';
export {
  checksumMismatch,
  contentTypeMismatch,
  contentTypeNotAllowed,
  contentTypeUnrecognised,
  deleteFailed,
  diskUnknown,
  getTooLarge,
  isStorageError,
  keyConflict,
  keyUnshared,
  listFailed,
  objectNotFound,
  orgMismatch,
  pathUnsafe,
  putFailed,
  putTooLarge,
  readFailed,
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_TITLES,
  StorageError,
  signedUrlExpired,
  signedUrlRejected,
  signedUrlUnverifiable,
  signingSecretMissing,
  tooLarge,
  uploadFailed,
  xmlBodyUnreadable,
} from './errors';
export { alreadyPromoted, quarantined } from './errors-promote';
export type { GrantUploadInput, UploadGrant, UploadRequest } from './grant';
export { grantUpload } from './grant';
export type {
  ImageFit,
  ImageSize,
  ImageTransform,
  SrcsetDescriptor,
  SrcsetOptions,
  VariantFormat,
} from './image';
// No `ImageFormat` and no `IMAGE_FORMATS` here, deliberately: `@ultimat3/core` owns that name and
// that set (what it can PROBE), this package owns `VARIANT_FORMATS` (what a variant can be minted
// in), and `image.test.ts` fails the day either core name reappears in this file.
export {
  blurPlaceholder,
  DEFAULT_QUALITY,
  DEFAULT_SRCSET_WIDTHS,
  fitDimensions,
  isVariantFormat,
  srcsetDescriptors,
  transformImage,
  VARIANT_FORMATS,
  variantKey,
} from './image';
export type {
  LockedAction,
  ObjectLock,
  ObjectLockOptions,
  ObjectRetention,
  RetentionMode,
} from './object-lock';
export { isLocked, ObjectLockedError, RETENTION_MODES } from './object-lock';

export {
  assertSafeKey,
  isSafeKey,
  isTenantScoped,
  isWithinOrg,
  joinKey,
  keyDirname,
  keyExtname,
  MAX_KEY_LENGTH,
  META_DIR,
  ORG_PREFIX,
  orgPrefix,
  scopedKey,
} from './path';
export type {
  SignedUrlConstraints,
  SignedUrlFailure,
  SignedUrlInput,
  SignedUrlVerification,
  VerifySignedUrlInput,
} from './signed-url';
export {
  buildSignedUrl,
  canonicalRequest,
  DEFAULT_SIGNED_URL_BASE,
  DEFAULT_SIGNED_URL_TTL_MS,
  SIGNED_URL_FAILURES,
  SIGNED_URL_PARAMS,
  SIGNED_URL_VERSION,
  signConstraints,
  signedUrlBaseFor,
  signedUrlBasePath,
  verifySignedUrl,
} from './signed-url';
export {
  DEV_SIGNING_SECRET,
  STORAGE_SIGNING_SECRET_KEY,
  usesDevStorageSecret,
} from './signing-secret';
export type { Storage, StorageConfig } from './storage';
export { definedStorage, defineStorage, disk, resetStorage, storage } from './storage';
export type { UploadCandidate, UploadPolicy, UploadPolicyInit, ValidatedUpload } from './upload';
export {
  contentTypeMatches,
  DEFAULT_MAX_UPLOAD_BYTES,
  DOCUMENT_CONTENT_TYPES,
  IMAGE_CONTENT_TYPES,
  normalizeContentType,
  sniffContentType,
  uploadPolicy,
  validateUpload,
} from './upload';
export type {
  SignedPut,
  SignedPutInput,
  UploadedFile,
  UploadFileInput,
  UploadProgress,
  UploadSource,
} from './upload-client';
export {
  defaultSignedPut,
  fetchSignedPut,
  uploadFile,
  xhrSignedPut,
} from './upload-client';
