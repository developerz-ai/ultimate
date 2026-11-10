// Single responsibility: the storage disk a boot installs — s3 when `S3_ENDPOINT` names one, the
// embedded local disk otherwise — and the two refusals that must come before the first upload
// rather than after it. Split from `runtime-services.ts` at its 500-line ceiling.

// why: Bun has no `mkdir`; the embedded root must exist before the disk is handed out.
import { mkdirSync } from 'node:fs';
import { isLocal, renderThrowable, resolveEnvironment } from '@ultimat3/core';
import { configuredHttp, defineHttpConfig } from '@ultimat3/http';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver, s3Driver, usesDevStorageSecret } from '@ultimat3/storage';
import type { StorageDriver } from '@ultimat3/storage/adapter';
import { LocalDiskUnsafeError, StorageUnwritableError } from './errors';
import type { DevServices, Env } from './runtime-bindings';
import { s3PathStyleOf } from './runtime-s3-path-style';

const FILE_SCHEME = 'file://';

/**
 * The most one request to this server carries — `http.maxRequestBodyBytes` as the server resolves
 * it, read at each signing because the boot builds its disk before the app's `configureHttp` runs.
 * Handed to `localDriver({ maxRequestBytes })`, so a single-PUT grant this server would refuse
 * with `X_BODY_TOO_LARGE` is refused when it is signed instead, naming `grantMultipart`.
 */
export const servedRequestCeiling = (): number =>
  defineHttpConfig({ ...configuredHttp(), rateLimit: { scope: 'process' } }).maxRequestBodyBytes;

/**
 * The storage disk this process will use.
 *
 * An `external` binding now reaches `s3Driver`. It used to fall through to a LOCAL directory —
 * `S3_ENDPOINT` selected a different root and nothing else, so every deployment that configured
 * object storage silently wrote to a container-local disk, and every upload was destroyed by the
 * next restart while the configured bucket stayed empty. Nothing failed; the files just went
 * nowhere.
 *
 * The embedded branch is also where a hardened container died. `mkdirSync` on a
 * `readOnlyRootFilesystem` throws a bare `EROFS` from inside Bun's fs, with no code, no fix and no
 * mention of storage — the demo CrashLooped 22 times on it. A read-only filesystem is a normal way
 * to run a container, so this reports what to do instead of what went wrong.
 */
export function startStorage(services: DevServices, env: Env, override?: StorageDriver): Storage {
  // First arm, not a branch beside the two below: `runtime.ts` handing the boot a driver has
  // already answered "which disk", and re-deriving one from `S3_ENDPOINT` would be a second answer.
  // Registered under the driver's own name — its signed URLs hang off that key (`defineStorage`).
  if (override !== undefined) {
    return defineStorage({ disks: { [override.name]: override }, default: override.name });
  }
  const binding = services.storage;

  if (binding.mode === 'external') {
    const bucket = env['S3_BUCKET'] ?? '';
    if (bucket === '') {
      throw new StorageUnwritableError(
        `S3_ENDPOINT is set to ${binding.url} but S3_BUCKET is empty, so there is no disk to write to`,
        'set S3_BUCKET to the bucket name, or unset S3_ENDPOINT to use the embedded disk',
      );
    }
    return defineStorage({
      disks: {
        object: s3Driver({
          bucket,
          endpoint: binding.url,
          ...(env['S3_REGION'] === undefined ? {} : { region: env['S3_REGION'] }),
          forcePathStyle: s3PathStyleOf(env),
        }),
      },
      default: 'object',
    });
  }

  const root = binding.url.slice(FILE_SCHEME.length);
  // The embedded disk is what this branch falls back to whenever `S3_ENDPOINT`/`S3_BUCKET` are
  // unset — including in `production` and `staging`, where an unset `STORAGE_SIGNING_SECRET` means
  // every signed upload grant is minted with the string published in this repo, and
  // `acceptSignedUpload` trusts a signed constraint over the app's own `uploadPolicy`.
  //
  // `localDriver` refuses that at construction on its own (`X_ENV_MISSING`). Pre-empted here so
  // the message names the STORAGE CHOICE and both ways out, rather than arriving as "a secret is
  // missing" from a helper the operator never configured. Not an outright ban on the local disk in
  // production: a single-node Compose deploy on a mounted volume WITH a real secret is a rung on
  // the scale ladder, and refusing it would be a deploy-shape decision, not a security fix.
  // `{ env }` on ALL THREE, never the ambient `process.env`: this function is HANDED the boot's
  // environment and reads `S3_BUCKET` off it one branch above, so a guard asking a second source
  // could answer `development` for a process booting as `production` — or, with
  // `usesDevStorageSecret({ env })` left bare, refuse a boot whose own env carries a real
  // `STORAGE_SIGNING_SECRET` because the PROCESS does not. Which environment, whether a secret
  // exists, and the name the message prints are one question about one table.
  // `fallback: 'production'` on both, the reading `localDriver` itself takes: a boot that names no
  // environment is not a development one, and this message beats the driver's to it.
  if (!isLocal({ env, fallback: 'production' }) && usesDevStorageSecret({ env })) {
    throw new LocalDiskUnsafeError({
      environment: resolveEnvironment({ env, fallback: 'production' }),
      root,
    });
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    const detail = renderThrowable(cause);
    throw new StorageUnwritableError(
      `the embedded storage disk needs ${root} and it could not be created: ${detail}`,
      `mount a writable volume at ${root}, or set S3_ENDPOINT and S3_BUCKET to use object storage instead`,
    );
  }
  // The guard three lines up reads `env`; so must the disk it guards. Otherwise the boot's
  // environment decides whether signing is allowed and the process's decides what key is used.
  // `maxRequestBytes`: a signed PUT lands on THIS server, so a grant it could never accept in one
  // request is refused at signing, naming the multipart grant.
  const disk = localDriver({ root, env, maxRequestBytes: servedRequestCeiling });
  return defineStorage({ disks: { local: disk }, default: 'local' });
}
