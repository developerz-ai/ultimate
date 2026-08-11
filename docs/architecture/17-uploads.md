# Uploads

Direct-to-storage file uploads: who signs, who verifies, where the bytes land, and what deletes
them when nobody claimed them. `As of 2026-08`.

Bytes never pass through an action. The server signs a constraint tuple, the browser PUTs at it,
and the server takes it back and re-checks everything the signature promised — because a
signature proves *what was granted*, never *what arrived*.

## The four hops

| # | Where | Call | Refuses on |
|---|---|---|---|
| 1 | server, inside the app's own `action` | `grantUpload({ disk, orgId, request, policy, target? })` | type off the allowlist, declared size over `maxBytes` |
| 2 | browser | `uploadFile({ file, grant, onProgress })` | file over the grant's `maxBytes` |
| 3 | the mounted `/_storage` route | `acceptSignedUpload({ url, secret, disk, orgId, bytes, declaredContentType })` | bad signature, expiry, wrong method, cross-org key, byte count, `Content-Type`, magic bytes |
| 4 | a `job` on a schedule | `sweepOrphans({ disk, orgId, olderThanMs })` | — deletes what step 3 wrote and nobody promoted |

Hop 3 is the only one that writes. Hops 1 and 2 exist to make a doomed transfer cost one round
trip instead of a full upload; neither is trusted by hop 3, and removing both would change no
security property.

## The client never names the key

`grantUpload` derives it:

```
org/<orgId>/pending/<uploadId><ext>              no row yet
org/<orgId>/<entity>/<id>/<field>/<uploadId><ext>  target: { entity, id, field }
```

Everything in that key comes from the server except `<ext>`, which is the client's filename
extension **only if** it matches `.[a-z0-9]{1,12}` — otherwise it is dropped, never sanitised.
The org segment is built by `scopedKey`, so another tenant's prefix is unreachable by
construction rather than by a check somebody remembered to write, and `acceptSignedUpload`
re-checks `isWithinOrg(key, actorOrg)` on the *verified* key so a forged one cannot probe org
names.

## What the signature covers, and what it cannot

`v1 \n METHOD \n key \n expiresAt \n maxBytes \n contentType` — six fields, newline-separated and
order-fixed. Editing `?x-max=` invalidates it, so a client cannot widen what it was granted.

What it cannot cover is the bytes, which is why hop 3 re-counts them and re-sniffs them.
`Content-Type` is attacker-controlled at every hop: the header must equal the signed type
(otherwise `X_STORAGE_URL_INVALID`), and the magic bytes must agree with that type (otherwise
`X_STORAGE_TYPE_REJECTED`). A `.png` that is really an HTML document is stored XSS the moment
any surface serves it back.

A `PUT` URL signed with **no** content type is refused outright. `grantUpload` always sets one,
so such a URL was hand-rolled, and the only alternative to refusing is trusting the uploader's
header — which is the thing the sniff exists to distrust.

| Failure | Code | Status |
|---|---|---|
| edited constraint, wrong base, `PUT` grant replayed as `GET`, contradicting header | `X_STORAGE_URL_INVALID` | 403 |
| the window closed; the signature was fine | `X_STORAGE_URL_EXPIRED` | 410 |
| key is unforged and belongs to another org | `X_STORAGE_ORG_MISMATCH` | **404** |
| more bytes than the signature granted | `X_STORAGE_TOO_LARGE` | 413 |
| magic bytes contradict the signed type | `X_STORAGE_TYPE_REJECTED` | 415 |

404 for a cross-org key, not 403: the org check runs before anything is read, so answering
"forbidden" would confirm that a key exists to the one caller who must not learn it.

## Why there is no `uploadAction()`

A model call gets one — `llm()` in [`../../packages/ai/src/llm.ts`](../../packages/ai/src/llm.ts)
*returns* an `action`, which is how it inherits `.tool()`, `.openapi()`, `.client()` and a
manifest entry without re-declaring any of them. The same shape is unavailable here, and the
reason is the tier table, not taste:

| Package | Tier | May import `action` (tier 3)? |
|---|---|---|
| `@ultimat3/ai` | 4 | yes — downward |
| `@ultimat3/storage` | 1 | **no** — upward |

`storage` is tier 1 because its real imports are `core` and nothing else, and that placement is
what lets `entity` hold its own Postgres driver. A factory over `action` cannot live there.

The shape that *does* fit is `@ultimat3/auth`'s, and it is the framework's actual convention:
**no framework package ships a pre-built `action`.** `auth` (tier 2) exports `login`,
`signInWithOAuth`, `completeOAuthLogin` as plain server functions and the app wraps each in its
own `action()` with its own policy. `grantUpload` is the same kind of function, and the wrap is
six lines the app has to write anyway, because the policy is the app's:

```ts
export const requestUpload = action({
  input: t.object({ filename: t.string(), contentType: t.string(), size: t.number() }),
  output: t.object({ key: t.string(), url: t.string(), contentType: t.string(), maxBytes: t.number(), expiresAt: t.number() }),
  policy: canUpload,
  handle: ({ input, ctx }) =>
    grantUpload({ disk: disk('uploads'), orgId: ctx.actor.orgId, request: input, policy: uploads }),
});
```

That action projects to HTTP, OpenAPI, the typed client, an MCP tool and the manifest like any
other — the projections come from `action()`, and nothing was lost by not wrapping the wrap.

## Mounting `/_storage`

`accept.ts` owns no `Request`, no `Response` and no status number: `@ultimat3/http`'s
`error-map.ts` is the only place an `X_*` code becomes a status, and a second table in a tier-1
package is the drift that rule exists to prevent. The host mounts two routes around the two
calls — the same shape `packages/cli/src/dev-assets.ts` already uses for `/media/*`:

```ts
{ method: 'PUT', path: '/_storage/local/*key', meta: { name: 'storage.put', auth: 'required' },
  handler: async (request) => Response.json(await acceptSignedUpload({
    url: request.url.toString(), secret, disk: storage.disk(), orgId: ctx.actor.orgId,
    bytes: new Uint8Array(await request.arrayBuffer()),
    declaredContentType: request.headers.get('content-type') ?? undefined,
  })) }
```

`localDriver`'s base is `/_storage/<driver>`; `s3Driver` presigns against the provider and never
touches this route.

## Orphans

An upload happens before the row it belongs to exists, so it lands under `pending/` and is
promoted by `promoteAttachment` once there is an id — copy first, delete second, because a delete
that ran first loses the bytes on a failed write.

That makes an orphan a fact about the key rather than a join nobody runs: anything still under
`org/<orgId>/pending/` past the window is unclaimed. `sweepOrphans` can reach only that prefix,
of one org, and returns the keys it deleted. A sweep that could reach an attached key is a job
that deletes production data the first time an app forgets to promote something.

## The UI half

`<FileInput>` keeps the platform control and styles `::file-selector-button` — the native button
is already localised, focusable and keyboard-driven. `<Dropzone>` is a real `<label>` around a
visually-hidden `<input type="file">`, so click, Enter and Space open the picker with no
`tabindex` and no synthetic click; dragging is the enhancement on top, never the only way in.

Both take a determinate `progress` (0..1) and report every chosen file through
`selectFiles(files, { accept, maxBytes, maxFiles })`, which returns `{ accepted, rejected }` with
a `reason` per refusal — `'type' | 'size' | 'count'`, a reason and not a message, because the
translated string is the app's. A file the browser could not type (`type: ''`) matches no MIME
pattern, wildcard included: the cheap half fails closed too.
