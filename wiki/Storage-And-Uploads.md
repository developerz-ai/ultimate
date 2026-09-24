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
| 3. server, at `/_storage` | `acceptSignedUpload({ url, secret, disk, orgId, bytes, declaredContentType, policy })` | refuses a bad or expired signature, a key outside the org, more bytes or another type than was granted, or magic bytes that contradict the type |

The signature covers the **constraints** (method, key, expiry, `maxBytes`, content type), so editing
`?x-max=` invalidates it. Uploads are **sniffed**: `validateUpload()` reads magic bytes and refuses a
`.png` that is really HTML (`X_STORAGE_TYPE_REJECTED`).

The local disk signs with `STORAGE_SIGNING_SECRET`. The shipped development secret is accepted
**only** in `development` or `test`; a process that names no environment is treated as production
and refused at construction (`X_ENV_MISSING`).

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
