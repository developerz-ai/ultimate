# @ultimat3/storage — history

The reasoning moved out of [`packages/storage/CLAUDE.md`](../../packages/storage/CLAUDE.md) (plan 101,
slice 17 f, `As of 2026-09-23`), verbatim and under its original headings. A record of why, never
a current fact: the rules that still hold are in that file, and where the two disagree it wins.

## @ultimat3/storage — agent notes

- **Every byte ceiling and every TTL is screened where it is DECLARED, through core's
  `finiteCount` and nothing else, `As of 2026-08-26`** — `uploadPolicy({ maxBytes })`, both
  drivers' `maxPutBytes`, `createUploadGrant({ expiresInMs })`, `buildSignedUrl`'s two and the s3
  driver's presign TTL. There was briefly a private `assertFiniteSignedUrlBound` here saying the
  same thing in its own words; a second finite-bound path is one that drifts from the shared
  contract, which is exactly what `jobs`, `realtime` and `query` each proved with a copy of their
  own. Both presigners now call the one function, which is what `driver-parity.test.ts` needs to
  stay true.
  Measured: `uploadPolicy({ maxBytes: Number.NaN })` accepted a 5,000,016-byte PNG through
  `validateUpload`, because `size > NaN` is false — the one number deciding how much a caller may
  store stopped deciding anything. Variant `quality` is core's `assertFiniteImageQuality` and NOT a
  second screen: `variantKey` never reaches the encoder, so a copy that disagreed would mint
  `q150` keys for bytes `transformImageBytes` then refuses.

- **The default is taken on `undefined` and on nothing else, `As of 2026-08-26`** —
  `options.x === undefined ? D : options.x`, never `options.x ?? D`. `??` coalesces on `null` too,
  so an explicitly blanked key in a decoded JSON config took the default BEFORE the screen above
  could refuse it: the mirror of the `NaN` half, where one value slips past the guard and the other
  past the default, and both end in a bound nobody chose. Every site above, `quality` included.

- **`MAX_KEY_LENGTH` is BYTES, and is measured in bytes, `As of 2026-08-26`.** S3's limit is "a
  sequence of Unicode characters whose UTF-8 encoding is at most 1,024 bytes long", and `path.ts`
  measured `key.length` — UTF-16 code units — while its message said "chars". A code-unit count is
  never MORE than the UTF-8 byte count, so a non-ASCII key over the real limit passed this guard
  and was refused by the store instead: 400 CJK characters is 400 units and 1,200 bytes. Keeping
  local and remote disks interchangeable is the whole reason the ceiling exists, so it has to be
  the store's ceiling. Same defect and same fix as `@ultimat3/cache`'s surrogate-key guard.

- **The local `list()` globs with `dot: true`, and the `META_DIR` skip is the REAL filter**
  (`As of 2026-08`). `Bun.Glob('**/*')` matches no dot-prefixed entry, so every object whose key
  had one — `.hidden.txt`, `org/o1/pending/.x.png`, the `.metadata/a.json` `path.test.ts` pins as
  legal — was missing from the listing while `put`/`get`/`exists` handled it normally and
  `s3Driver.list()` returned it: the key space and the listing disagreed by construction.
  `sweepOrphans` pages through `list()`, so those objects were reported as erased while still on
  disk — a false erasure report by OMISSION, the same lie a swallowed listing error tells. The
  `.meta/` skip one line below was unreachable until this landed and this file called it "a second
  line of defence"; it is now the only thing keeping the sidecar tree out of the object namespace,
  and it folds case for `isSafeKey`'s reason. Pinned in `driver-parity.test.ts`.

- **`head()` NEVER reads an object's bytes, and `list()` is why** (`As of 2026-08`). It hashed a
  sidecar-less object to invent an etag, under a comment saying "`list()` must not read every file
  it lists" — which is what `list()` then did, one whole buffered object per listed row,
  sequentially, and `copy()` inherited it, so a copy documented as never routing bytes through the
  heap buffered the entire source. A listing that cannot know an etag reports `''`, which is what
  the s3 listing already answers. `get()` hashes out of bytes it already holds; `copy()` passes
  `hash: true`, because the sidecar it writes at the destination would otherwise carry `etag: ''`
  as a durable lie.

- **`localDriver({ env })` and `usesDevStorageSecret({ env })` are ONE question about ONE table**
  (`As of 2026-08-23`). The predicate learned core's `env` slot first, so `dev-runtime.ts`'s guard
  — `!isLocal({ env }) && usesDevStorageSecret({ env })` — asked about the BOOT while the
  constructor it guards still read `process.env` for the secret, for `isLocal()` and for the
  environment its refusal names. An embedding caller whose env is not the process's (`serveApp({ env })`,
  a test fixture) got the verdict from one table and the behaviour from another, in the dangerous
  direction: a production boot with no secret, launched from a development shell that has one,
  signing every grant with the published literal. All three reads now come off `options.env ??
  process.env`, so a bare `localDriver({ root })` is unchanged and additive.
  `driver-local-boot.test.ts` pins it by mutation — reverting any one read to `process.env` fails.
  That file is the CONSTRUCTION half, split off `driver-local.test.ts` at the line ceiling along
  the seam the guard already draws: nothing in it writes a byte, so it needs no temporary
  directory, and `driver-local.test.ts` keeps everything the disk actually does with an object.

- **`VARIANT_FORMATS` is this package's format vocabulary, and `IMAGE_FORMATS` is core's.** Until
  9.0.0 both packages exported `IMAGE_FORMATS` **and** `ImageFormat` from their own barrels over
  different sets (core: `png|jpeg|webp|avif|gif|svg`, what it can PROBE; storage: `avif|webp|jpeg|png`),
  so a caller narrowing on storage's held a type saying `gif` and `svg` could not occur and a
  `probeImage()` value that was one — and `variantKey('photos/hero.gif', { format })` minted
  `photos/hero@full.undefined`, a well-formed writable key naming a file nothing can serve. The set
  is now a strict subset **by the compiler**: `as const satisfies readonly ImageFormat[]`, so a
  member core cannot name is a build error here. `isVariantFormat` takes `string` on purpose, so
  `probeImage(bytes).format` narrows through it with no cast. `avif` is in the set and `gif`/`svg`
  are not because the question is what a variant KEY can carry, never what core can transform —
  core decodes `gif` perfectly well, and naming this set `TRANSFORMABLE_FORMATS` would have been
  the same lie one rename later. `scripts/render-modes.ts` holds the `IMAGE_FORMATS` row (`by:
  'name'`) and `image.test.ts` fails the day either core name reappears in `src/index.ts`.

- **Bundle, `bun build --target=browser --minify`, `import { uploadFile } from '@ultimat3/storage'`**
  (`As of 2026-09-22`): **11,822 B** at 20.2.1, **17,767 B** on `clientTransport`. The +5.9 kB is
  core's transport graph, paid only where the chunk did not already carry it — an island that
  also calls an action or a query already does.

- **Plan 101 (2026-10), what changed and why.**
  - `promoteAttachment` takes the **policy** and measures with `stat()`. `get` + `put` became
    `copy` long ago; the size was still never read, so on s3 the grant's `maxBytes` bound nothing.
    `stat` is REQUIRED on `StorageDriver` — it shipped optional for one review round with a runtime
    `X_NOT_IMPLEMENTED`, and a contract enforced at runtime only is not one.
  - `lastModified` is optional. Epoch 0 for a provider that sent none was read by `sweepOrphans` as
    "older than any window"; an invalid `Date` sentinel replaced it for one round and was dropped
    for the same reason as the optional `stat` — a value a reader has to remember to test.
  - The signed tuple is `v2` and carries the base PATH: every local disk shares one secret, so a
    URL for one disk verified on another.
  - A variant key keeps the whole source key (`hero.png@w640.webp`); the extension was cut, so
    `hero.png` and `hero.jpg` shared one cached variant.
  - `get()` has a ceiling (`maxGetBytes`) on every driver.
  - The local write is staged and renamed in the order **marker, sidecar, bytes, clear marker**.
    The 2026-09-28 plan said "sidecar last" and sweep 2 said "sidecar first"; neither is sound
    alone — bytes-first serves new bytes under the old type, sidecar-first serves old bytes under
    the new one. The pending marker (the new etag, beside the sidecar) is what makes the torn pair
    detectable, and sidecar-before-bytes is what makes a torn FRESH write absent rather than
    typeless. `driver-local-crash.test.ts` dies at every step.
  - A refused write is `X_STORAGE_PUT_FAILED` on local and s3; a key that is another key's path on
    the local disk is `X_STORAGE_KEY_CONFLICT`. Suffixed on-disk names were considered and not
    taken: they need a migration for every existing root.

- **The signed base, before it was stated once on the driver** (moved from the package notes,
  2026-10): Before that, the base was stated twice (`/_storage/local` in the driver, `/_storage` in `verifySignedUrl`'s default) and NO genuine URL verified at all: the key parsed as `local/<key>`.

## Two reserved-key and list rules (moved from the package notes, 2026-10)

- **Why `META_DIR` is reserved case-insensitively**: `.META/a.txt.json` was a legal key that wrote
  `<root>/.META/a.txt.json`, which on APFS and NTFS IS `<root>/.meta/a.txt.json` — the sidecar for
  object `a.txt` — so a caller able to name a key rewrote another object's recorded `contentType`.
- **Why `list()` refuses everything but `ENOENT`**: both drivers broke `delete()`'s rule in
  opposite directions. The local one caught EVERYTHING and answered
  `{ objects: [], truncated: false }`, so `EACCES` on the root read as "this disk is empty"; the s3
  one let a bare `S3Error` escape uncoded, with nothing for the http error map to render but a
  500. `sweepOrphans` walks `list()`, so the local swallow was a false-erasure report a layer up.

## Object Lock (plan 101 sweep 10a, `As of 2026-10-06`)

- **Why the s3 disk has a second transport.** `Bun.S3Client`'s `write` takes a type, an ACL and a
  storage class and no header, so `x-amz-meta-*`, `Cache-Control` and `x-amz-object-lock-*` could
  not be sent — the driver refused metadata and cache-control with `X_NOT_IMPLEMENTED`, and Object
  Lock was not in `PutOptions` at all. Core's `signAwsRequest` (the framework's one SigV4 signer,
  shared with the SES driver) made a signed `fetch` possible. Only a `put()` carrying one of those
  options takes it; a plain `put()`, every read, `copy`, `list`, `delete` and the presign stay on
  Bun. One signed path for EVERY put (plan 102/03, with a checksum on each) was not taken: it
  rewrites every fake-client test for no new capability. The signed path restates Bun's
  addressing (path style unless `forcePathStyle === false`, `auto` region, AWS regional endpoint)
  from the same options, and a refusal is read into `S3Error`'s `code`/`message`/`statusCode`, so
  `regionMismatch` and `isAbsentObject` classify it unchanged. Restating the addressing was not enough: Bun
  also falls back to `S3_ENDPOINT`/`AWS_ENDPOINT`, `S3_REGION`/`AWS_REGION` and
  `S3_SESSION_TOKEN`/`AWS_SESSION_TOKEN` (measured on 1.4.2; CodeRabbit on PR #665), so a disk
  configured through the environment signed its PUTs for AWS. `resolveS3Target` now reads that
  table once and `buildClient` hands the result to Bun explicitly. The PUT always carries
  `Content-MD5`: S3 requires one with a retention, and it turns a body changed in flight into
  `BadDigest`.
- **Why local and memory refuse while s3 does not.** S3 locks a VERSION. A DELETE with no version
  id writes a delete marker and succeeds; a PUT writes a newer version and succeeds; the locked
  version stays (measured on a versioned Versity gateway). The local and memory disks keep one
  version per key, so the only way to keep locked bytes is to refuse the delete, the overwrite and
  the copy onto the key. The refusal was first `X_STORAGE_DELETE_FAILED`/`X_STORAGE_PUT_FAILED`
  and became its own code, `X_STORAGE_OBJECT_LOCKED` (409, `ObjectLockedError`): a lock is the
  object's state, not the disk failing, and a caller must tell the two apart. The divergence is
  pinned in `driver-parity.test.ts`.
- **The lock is read from the sidecar as RECORDED**, even when the pending marker puts the pair in
  doubt: a torn write must never unlock an object. The check runs inside the key's `keyedQueue`,
  so it is in-process only, like every other local write rule.
- **`retentionOf` answers `{ legalHold: false }` for "nothing locks it"** — no configuration on the
  object (`NoSuchObjectLockConfiguration`, a 404, so asked before `isAbsentObject`) and a bucket
  made without Object Lock (`InvalidRequest … Object Lock`) alike: the question a caller asks is
  "may I delete this?". A denied read of EITHER half is the answer, never "unlocked".
- **A malformed lock option stays `X_INVARIANT`** — a mode outside the two, an invalid instant, a
  `retainUntil` already past (S3 answers it 400; a local disk would store a lock that never held).
- **`retentionOf` is optional on `StorageDriver`**, like `registerAs`: required, it breaks every
  hand-written driver in other packages' tests. All three shipped disks implement it.
- A `copy()` does not carry the source's lock: on S3 a lock is per version and set by the request.

