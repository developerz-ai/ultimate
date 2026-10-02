# Storage and uploads

**Call sites name a disk, never a driver.** Package `@ultimat3/storage` (tier 1) — the full
reference is
[`packages/storage/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/storage/README.md),
and the upload design is
[`docs/architecture/17-uploads.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/17-uploads.md).

```ts
import { defineStorage, disk, localDriver, s3Driver, scopedKey } from '@ultimat3/storage';

defineStorage({
  disks: {
    uploads: localDriver({ root: '.storage/uploads' }),
    media: s3Driver({ bucket: 'media', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
  },
  default: 'uploads',
});

await disk('media').put(scopedKey(orgId, 'avatars', 'a.png'), bytes, { contentType: 'image/png' });
```

Swapping `local` for `s3` changes no call site, and `x dev` needs no S3 server.

| Driver | Backing | For |
|---|---|---|
| `localDriver` | `Bun.file` under one root; writes are staged and renamed in an order whose every crash point reads as absent, whole or untyped — never a wrong content type | dev, tests, a single node. A key cannot be a path prefix of another (`a` and `a/b`): the second is `X_STORAGE_KEY_CONFLICT`. `s3Driver` and `memoryDriver` hold both |
| `s3Driver` | `Bun.s3` | any S3-compatible endpoint — AWS, R2, a self-hosted gateway. The difference is `endpoint`, `region` and `forcePathStyle`. Credentials are env var **names**, never literals |
| `memoryDriver` | a `Map` in this process | a test's disk: `defineStorage({ disks: { uploads: memoryDriver() } })`. Every method `localDriver` answers, the same refusals, the same signing rule; `objects()` is a copy of the stored bytes by key. Never a deployment's disk — a restart is every object gone |

**A declaration holds a disk by THUNK, never by value.** `disk('sessions')` resolves through
`defineStorage()`, which boot runs after an app's modules were evaluated — so a `scrape()` or any
other declaration built at import time takes `() => disk('sessions')` and reads it when it is
used ([Scraping](Scraping)). Called at module scope, `disk()` is `X_CONFIG_INVALID`: storage was
not defined yet.

A real S3 on a laptop is `docker/docker-compose.dev.yml`'s `s3` service — Versity S3 Gateway over a
volume, with the bucket already there (a directory under its root is a bucket, and the volume is
mounted at one). Point the app at it with `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_BUCKET=<app>`,
`S3_FORCE_PATH_STYLE=1` and the key pair the file ships. That file chooses a server for development
only — production is whichever S3-compatible endpoint you run.

`S3_REGION` is the region requests are signed for. Unset, they are signed for `auto`: what R2 wants
and what the dev gateway is started with. An endpoint that expects another region refuses the
first write, list or delete with `X_CONFIG_INVALID`, and the fix line names the value to set.

## Keys are refused, never sanitised

`assertSafeKey()` runs on every key: `..`, absolute keys, backslashes, control bytes, encoded
separators, empty segments and over-long keys are `X_STORAGE_PATH_UNSAFE`. `scopedKey(org, …)` is
`org/<org>/…`; a surface guards a client key with `isWithinOrg(key, ctx.actor.orgId)` and
`isTenantScoped(key)` (`X_STORAGE_ORG_MISMATCH`).

## The direct-upload round trip

User uploads never go through `put()` (which buffers, and stops at `maxPutBytes`, 10 MB by default).
They go straight to the disk, in three calls — and **the client never names the key**:

| Hop | Call | What it guarantees |
|---|---|---|
| 1. server, in an action | `grantUpload({ disk, orgId: ctx.actor.orgId, request, policy })` | a signed grant for a key the server chose, under the actor's org |
| 2. browser | `uploadFile({ file, grant, onProgress })` | a PUT with real progress; `storage/upload-client.ts` is the one XHR seam in the browser |
| 3. server, at `PUT /_storage/:disk/*key` | mounted by the framework in `x dev` and `runRole`, around `acceptSignedUpload`. Answers `201 { key }` | refuses a bad or expired signature, a key outside the actor's org, more bytes or another type than was granted, or magic bytes that contradict the type |

**The mounted `PUT`** (`As of 2026-09-24`, #523) requires a signed-in actor, like the `GET`. It
needs no permission: the grant is the authorization, and the action that minted it ran its own
policy. The route checks the signature and the expiry, and it checks that the key is inside the
actor's org. It validates the upload against what the grant signed (the content type and
`maxBytes`), so a PDF granted under `uploadPolicy({ allowedContentTypes: ['application/pdf'] })`
is accepted, and it does not use `uploadPolicy()`'s image-only default. The signed `maxBytes` caps
how much of the body is read. `bodyLimitBytes` does not, and neither does an unverified query value.

The signature covers the **constraints** (the disk's base path, method, key, expiry, `maxBytes`,
content type), so editing `?x-max=` invalidates it — and so does moving the URL to another disk:
every local disk signs with the one `STORAGE_SIGNING_SECRET`, and the base path
(`/_storage/<disk>`) is what keeps a grant for `uploads` from verifying on `evidence`. Uploads are
**sniffed**: `validateUpload()` reads magic bytes and refuses a `.png` that is really HTML
(`X_STORAGE_TYPE_REJECTED`). ISO base media files are told apart by their major brand, so
`image/avif`, `image/heic`, `video/quicktime`, `audio/mp4` and `video/mp4` each pass when the
policy allows them; `audio/x-m4a` and `video/x-m4v` are read as `audio/mp4` and `video/mp4`.

**On an s3 disk the grant's `maxBytes` is measured later, not at the PUT.** A provider presign
carries no size, so the browser's PUT is unbounded there. `promoteAttachment` is where it is
measured, and `get()` refuses an object over the disk's `maxGetBytes` (default: its `maxPutBytes`,
10 MB) with `X_STORAGE_TOO_LARGE` — read anything larger with `stream()`.

The local disk signs with `STORAGE_SIGNING_SECRET`. The shipped development secret is accepted
**only** in `development` or `test`; a process that names no environment is treated as production
and refused at construction (`X_ENV_MISSING`).

## Which disks `/_storage` and `/media` serve

`As of 2026-09-24` (#524): **the app's own.** Both routes read the process's one registry per
request. That registry is the last `defineStorage()` call, which is the app's when an app module
declares its disks. The boot's env-selected disk (`object` on `S3_ENDPOINT`, else `local`) is
served only when nothing declared one. A `defineStorage` at module scope in any file under
`apps/*/` is enough:

```ts
// apps/web/shared/storage.ts
export const storage = defineStorage({
  disks: { uploads: localDriver({ root: '.storage/uploads' }), evidence: s3Driver({ bucket }) },
  default: 'uploads',
});
```

| | |
|---|---|
| `storage:read` | the `GET` requires it. When an app declares its own disks, `x verify`'s `policy` step reports `X_PERMISSION_UNKNOWN` if the app's permission set lacks `storage:read`. Before this, the first signed URL returned a `500` |
| the boot's own disk | still built. In production with no `S3_ENDPOINT`, that is a local disk and still needs `STORAGE_SIGNING_SECRET`. To skip it, export `runtime = { storage }` from `apps/<app>/runtime.ts`. `runRole` reads that file, and it replaces the env-selected disk entirely |
| `definedStorage()` | the registry or `undefined`, without a throw. It is the question the routes ask |

## Attachments, quarantine, orphans

An upload lands under `org/<org>/pending/…` before its row exists, and is promoted once it has one:

| Call | Does |
|---|---|
| `promoteAttachment({ disk, key, orgId, target, policy })` | measure, copy, then delete, onto `org/<org>/<entity>/<id>/<field>/…`. **`policy` is required** — pass the one the upload was granted under: the object's size is read with `stat()` and one over `policy.maxBytes` is `X_STORAGE_TOO_LARGE` and stays pending. Only a **pending** key: another row's attached key is `X_STORAGE_NOT_PENDING`. Safe to retry: a source already moved answers the attached object |
| `grantUpload({ …, quarantine: true })` → `releaseQuarantine({ disk, key, orgId })` | the place for your scanner: a quarantined key cannot be promoted (`X_STORAGE_QUARANTINED`) until your scan job releases it. The scanner is your app's (axiom 8) |
| `sweepOrphans({ disk, orgId, olderThanMs })` | deletes stale `pending/` keys of one org and answers `{ deleted, failed }` — a refused delete is reported, never counted as done |

## Images

A variant's key is the whole source key plus the transform — `photos/hero.png` at width 640 is
`photos/hero.png@w640.webp` — so two sources that differ only by extension never share a cached
variant. `width` and `height` are whole numbers of at least 1 (`X_INVARIANT` otherwise).

`transformImage()` and `blurPlaceholder()` run on core's pipeline (`Bun.Image`, no `sharp`) and
encode `png`, `jpeg` and `webp`; `avif` is key and `srcset` math only. `variantKey()`,
`srcsetDescriptors()` and `fitDimensions()` are pure, which is how [SEO](SEO) builds `srcset`
without decoding a byte.

Every `X_STORAGE_*` code is in [Error codes](Error-Codes). Encryption at rest, lifecycle rules and
storage classes are **bucket** configuration, not the framework's (axiom 7).
