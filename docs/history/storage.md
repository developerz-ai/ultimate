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
