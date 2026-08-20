// Single responsibility: the public API of @ultimat3/storage. Explicit named exports only —
// every consumer imports from here, so this list is the package's contract.

export type { AcceptSignedUploadInput, SignedRequestInput } from './accept';
export { acceptSignedUpload, readSignedObject } from './accept';
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
  ListPage,
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
  DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT,
  etagOf,
  // Exported for the same reason `toBytes` is: a driver written outside this package has to
  // refuse a `limit` the same way both shipped ones do, or it is a third answer to one question.
  resolveListLimit,
  sha256Base64,
  toBytes,
} from './driver';
export type { LocalDriverOptions } from './driver-local';
export {
  DEV_SIGNING_SECRET,
  localDriver,
  STORAGE_SIGNING_SECRET_KEY,
  usesDevStorageSecret,
} from './driver-local';
export type {
  S3ClientLike,
  S3DriverOptions,
  S3FileLike,
  S3ListEntryLike,
  S3ListResultLike,
  S3StatLike,
} from './driver-s3';
export { s3Driver } from './driver-s3';
export type { StorageErrorCode, StorageErrorInit } from './errors';
export {
  checksumMismatch,
  contentTypeMismatch,
  contentTypeNotAllowed,
  deleteFailed,
  diskUnknown,
  isStorageError,
  listFailed,
  objectNotFound,
  orgMismatch,
  pathUnsafe,
  putTooLarge,
  quarantined,
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_TITLES,
  StorageError,
  signedUrlExpired,
  signedUrlRejected,
  signedUrlUnverifiable,
  signingSecretMissing,
  storageNotImplemented,
  tooLarge,
  uploadFailed,
} from './errors';
export type { GrantUploadInput, UploadGrant, UploadRequest } from './grant';
export { grantUpload } from './grant';
export type {
  ImageFit,
  ImageFormat,
  ImageSize,
  ImageTransform,
  SrcsetDescriptor,
  SrcsetOptions,
} from './image';
export {
  BLUR_PLACEHOLDER_WIDTH,
  blurPlaceholder,
  DEFAULT_QUALITY,
  DEFAULT_SRCSET_WIDTHS,
  fitDimensions,
  IMAGE_FORMATS,
  srcsetDescriptors,
  transformImage,
  variantKey,
} from './image';

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
  timingSafeEqual,
  verifySignedUrl,
} from './signed-url';
export type { Storage, StorageConfig } from './storage';
export { defineStorage, disk, resetStorage, storage } from './storage';
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
