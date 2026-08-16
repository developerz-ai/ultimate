// The secrets slice of `@ultimat3/core`'s public surface: the redacted-by-value `Secret`, the
// committed envelope, the files and install path around it, and the codes it throws. One group
// because they are one path — a committed ciphertext to a value `defineEnv` can read — and
// `index.ts` re-exports every name below explicitly, so the package's surface is unchanged.

export type { Secret } from '../secret';
export {
  isSecret,
  revealOptionalSecret,
  revealSecret,
  SECRET_BRAND,
  secret,
} from '../secret';
export type {
  SecretSummary,
  SecretsEnvelope,
  SecretsLocation,
  SecretValues,
} from '../secrets';
export {
  assertSecretValues,
  describeSecrets,
  generateMasterKey,
  masterKeyId,
  openSecrets,
  parseMasterKey,
  parseSecretsEnvelope,
  SECRET_NAME,
  SECRETS_ALG,
  SECRETS_IV_BYTES,
  SECRETS_KEY_BYTES,
  SECRETS_KEY_HEX_LENGTH,
  SECRETS_KEY_ID_LENGTH,
  SECRETS_TAG_BYTES,
  SECRETS_VERSION,
  sealSecrets,
  serializeSecretValues,
} from '../secrets';
export type { SecretsErrorCode } from '../secrets-errors';
export {
  SECRETS_ERROR_CODES,
  SecretsFileInvalidError,
  SecretsFileMissingError,
  SecretsKeyInvalidError,
  SecretsKeyMismatchError,
  SecretsKeyMissingError,
  SecretsPlaintextInvalidError,
  SecretsTamperedError,
} from '../secrets-errors';
export type {
  MasterKeyRef,
  MasterKeySource,
  SecretsInstallOptions,
  SecretsInstallReport,
} from '../secrets-store';
export {
  findMasterKey,
  installSecrets,
  masterKeyIdOf,
  masterKeyPath,
  readSecretsFile,
  requireMasterKey,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_FILE,
  SECRETS_KEY_MODE,
  secretsFileExists,
  secretsPath,
  writeMasterKeyFile,
  writeSecretsFile,
} from '../secrets-store';
