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

Swapping `local` for `s3` changes no call site, and `x dev` needs no MinIO.

| Driver | Backing | For |
|---|---|---|
| `localDriver` | `Bun.file` / `Bun.write` under one root | dev, tests, a single node |
| `s3Driver` | `Bun.s3` | MinIO, R2, AWS — the difference is `endpoint` + `forcePathStyle`. Credentials are env var **names**, never literals |

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

The signature covers the **constraints** (method, key, expiry, `maxBytes`, content type), so editing
`?x-max=` invalidates it. Uploads are **sniffed**: `validateUpload()` reads magic bytes and refuses a
`.png` that is really HTML (`X_STORAGE_TYPE_REJECTED`).

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
| `promoteAttachment({ disk, key, orgId, target })` | copy then delete, onto `org/<org>/<entity>/<id>/<field>/…`. Only a **pending** key: another row's attached key is `X_STORAGE_NOT_PENDING` |
| `grantUpload({ …, quarantine: true })` → `releaseQuarantine({ disk, key, orgId })` | the place for your scanner: a quarantined key cannot be promoted (`X_STORAGE_QUARANTINED`) until your scan job releases it. The scanner is your app's (axiom 8) |
| `sweepOrphans({ disk, orgId, olderThanMs })` | deletes stale `pending/` keys of one org and answers `{ deleted, failed }` — a refused delete is reported, never counted as done |

## Images

`transformImage()` and `blurPlaceholder()` run on core's pipeline (`Bun.Image`, no `sharp`) and
encode `png`, `jpeg` and `webp`; `avif` is key and `srcset` math only. `variantKey()`,
`srcsetDescriptors()` and `fitDimensions()` are pure, which is how [SEO](SEO) builds `srcset`
without decoding a byte.

Every `X_STORAGE_*` code is in [Error codes](Error-Codes). Encryption at rest, lifecycle rules and
storage classes are **bucket** configuration, not the framework's (axiom 7).
