# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Declare `@ultimat3/*` at the exact `<version>`, as `x new` and `x upgrade` write and `x doctor` holds an app to (`X_FRAMEWORK_PIN_RANGE`); keep every one on the same version, since a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers. From 23.0.0 on, each `BREAKING —` line names its migration as `(#N)` straight after the dash — row N of that major's `Entry by entry` table in Upgrading — and `bun run changelog-check` refuses a line without one (`X_DOC_MIGRATION_UNPAIRED`).

**Majors 1 through 30 were the pre-stability line**: shipped from 2026-08 under semver, often weeks apart, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). v31 is the stable line: from it, at most one major every 90 days (`X_RELEASE_MAJOR_WINDOW`), breaking changes wait on `next` (`X_BREAKING_ON_MAIN`), and the previous major gets security fixes for six months — [Stability](https://github.com/developerz-ai/ultimate/wiki/Stability).

## [Unreleased]

### Added
- `@ultimat3/auth`: a passkey label. `renamePasskey(auth, { userId, id, label })` names or renames a passkey — right after `register`, or later (`null` clears; owner-scoped, `null` for another user's id). `PasskeyCredential.label`, the optional `PasskeyStore.renamePasskey` (both shipped adapters implement it; `authAdapterConformance` holds it), and `x_passkeys.label`, added at every boot. A label blank, over 64 characters, or holding a control character or a lone surrogate after trimming is `X_PASSKEY_LABEL_INVALID`; an adapter without the member is `X_PASSKEY_RENAME_UNSUPPORTED`.
- `@ultimat3/auth`'s authorization server names one grant: `resolve(token)` answers `grantId`, kept across every refresh rotation; `grants({ subject, clientId? })` lists a subject's live grants (`grantId`, `clientId`, `scopes`, `resource`, `createdAt`, `refreshedAt`), oldest first; `revokeGrant({ subject, grantId, clientId? })` ends that grant alone, refresh tokens included, and answers 0 for another subject's id. Both are optional members of `AuthorizationServer`, so an app's own implementation still compiles; `authorizationServer()` always sets them. `AuthServerStore` gains an optional `liveGrants(filter, at)`, implemented by the memory and Postgres stores; a store without it makes `grants()` `X_AUTH_GRANTS_UNSUPPORTED` (501). No schema change: every grant row already had its id.
- `@ultimat3/auth`: `verifySessionWithUser(auth.sessions, auth.adapter, token)` (and `VerifiedSession`) is exported — the one-read session-and-user check `authenticate` runs, for a hook that needs the session and the user rather than an actor.
- `@ultimat3/core`: an env key may be required only in some environments — `{ type: 'string', required: false, requiredIn: ['staging', 'production'] }` is `X_ENV_MISSING` in a deploy and `undefined` in development and test. `describeEnv` reports `requiredIn`.
- `@ultimat3/testing`: `renderRoute(page, { cookies })` renders inside a GET request carrying those cookies, so `load` reads them with `useRequestCookie`.
- `@ultimat3/notify`: a visible native push takes `sound` (APNs `aps.sound`, FCM `android.notification.sound`), `interruptionLevel` (`aps.interruption-level`), `category` (`aps.category`) and `channelId` (`android.notification.channel_id`) on `NotifyPushMessage`; `webPush()` ignores them. Screened once before any device (`X_NOTIFY_PUSH_MESSAGE_INVALID`, `meta.field`); a message without them sends the same bytes as before.
- action: `drawMeter(ctx, { meter, period, amount, limit, key })` counts work measured after the fact (tokens, bytes, rows) on the caller's meter counter: the amount is added whole only within the limit, else `X_METER_EXCEEDED` with nothing counted; a second draw under one `key` adds nothing and answers `replayed: true`, across replicas, through the next period. Same counters as a `meter:` of that name ([Actions → Programmatic draws](wiki/Actions.md#programmatic-draws-drawmeter)). `MeterDraw` gains optional `amount` and `drawKey`, `MeterDrawResult` an optional `replayed`; `SQL_METER_KEY_TABLE` (`x_meter_key`) is new, applied by the boot beside `SQL_METER_TABLE`. `meterStoreConformance` checks both.
- `@ultimat3/notify`: `nativePush({ onReport })` receives each settled send's `NativePushReport` — `{ to, kind, report: { accepted, refused, removed, skipped } }`, one count per device; a throw from it is reported and the send still settles. `accepted` counts what APNs or FCM took, never a delivery.
- `@ultimat3/realtime`: `deviceSocket({ onOpen, onClose })` — a socket's open and close, as the device's actor, run beside the socket path (a throw is reported, the socket goes on); `onClose` reads the close `reason`. At least once: a node that dies holding sockets still yields their close, `reason: 'node lost'` (`DEVICE_NODE_LOST`), from the serving node that leads the next beat. Without `onClose`, nothing is written to the bus.
- `@ultimat3/entity`: `allOf(...predicates)` and `anyOf(...predicates)`, the conjunction and disjunction over invariant expressions, for a CHECK or an index `where` over several columns at once — `where: (c) => allOf(c.a.isNull(), c.b.isNull())` is a declared partial index, where a hand-written one drew `X_DB_INDEX_UNDECLARED`. Rendered `(a) and (b)` / `(a) or (b)`, judged in the app in SQL's three values.
- A bearer mount acts one token across tenants: `defineApi({ http: { mounts: [{ …, tenant: { arg, resolve, list } }] } })` (and `bearerMount({ tenant })` in `@ultimat3/http`) reads the tenant a call names as `?<arg>=<value>` in the mount's authenticator, before the rate limit, the body and the policy, and `resolve({ person, value })`'s actor is the caller from there on. MCP's three outcomes: no tenant is 400 `X_BEARER_TENANT_REQUIRED`, a tenant the person is not in answers the out-of-scope 404 byte for byte, and a `resolve` that throws is 500 `X_BEARER_TENANT_UNRESOLVED`. `GET <prefix>/tenants` lists the person's tenants, and the mount's OpenAPI document requires the parameter on every operation. A mount without `tenant` is unchanged.
- `@ultimat3/realtime`: `deviceLink.disconnect(ctx, deviceId, reason)` closes one device's socket from any role, on the node that holds it: `true` once closed, `false` when no socket is open under the caller's tenant. A reason past a close frame's 123 bytes is `X_CONFIG_INVALID`; a holder that never confirms, `X_DEVICE_REQUEST_TIMEOUT`. `disconnect` is an optional member of `DeviceSocket`, so an app's own implementation still compiles; `deviceSocket()` always sets it.
- core: `outbound({ refusal })` reads a non-2xx body as the caller declares. `refusal: { schema }` reads the whole body within the call's `maxBytes` and puts the schema's answer, credential-named fields redacted at any depth, at `meta.fields` on `X_OUTBOUND_REFUSED`, `X_OUTBOUND_UNAVAILABLE` and `X_OUTBOUND_THROTTLED`; a body that is not JSON, does not fit or passes the cap leaves it unset. `refusal: { detail: false }` keeps `meta.detail` at `''`, so a body's free text is never kept. Unset, nothing changes: `meta.detail` is still the redacted 200-character excerpt of the first KiB ([Outbound HTTP → refusal](wiki/Outbound-HTTP.md#refusal-what-a-non-2xx-body-becomes)). `OutboundRefusalRead` is exported from `@ultimat3/core/outbound`.
- `@ultimat3/auth`: `signInWithLink(auth, { purpose, identifier, token, signUp? })` signs a user in from a mailed link issued under a purpose the app declared (`defineVerificationPurpose`). It answers what `login()` answers; with TOTP enrolled it answers `X_MFA_REQUIRED` with the sealed challenge and writes no session, and `completeMfa` finishes the sign-in. The link is consumed before anything else is read, the built-in `email-verify` and `password-reset` purposes are refused (`X_CONFIG_INVALID`), and an account that never verified its address is not claimed.
- MCP recipes take a `section`: `{ name, section: 'ref' }` is served as `docs://ref/<name>` on `docs` and `resources/read`, and `markdownRecipes({ dir })` reads one sub-folder level as the section (`ref/errors.md` → `docs://ref/errors`; `recipes/<name>.md` is `<name>.md`). A section, like a name, is lowercase letters and digits in groups joined by single `-` (`ref-v2`; never `-ref`, `ref-` or `ref--v2`) (`X_MCP_RECIPE_URI_RESERVED`), a `resources:` URI under a section recipes use is refused, and `extraRecipes` may add a caller's own section. Folders under a recipe directory were ignored before and are now loaded.
- `aliases` on a recipe (`aliases: a, b` in markdown frontmatter) score in `docs({ q })` as the title does.
- `@ultimat3/ui`: `defineTheme({ motion: { duration, easing } })` sets an app's own durations and curves by rung (`DurationName`, `EasingName`, now exported), emitted at `:root` beside radius and font, so every `t.duration()` and `t.easing()` reads them. A time is `^(0|\d+(\.\d+)?(ms|s))$`, a curve `cubic-bezier()` of four numbers with x1 and x2 in [0, 1]: anything else is `X_UI_INVALID_VALUE`, an unknown rung `X_TOKEN_UNKNOWN`. The shipped `raw-motion` guard's fix for a stylesheet re-declaring `--duration-<rung>` or `--easing-<rung>` now names this slot (it pointed the property at another rung); a copy in `guards/` takes it with `x g guard raw-motion --force`.
- `defineAppMcp({ docsTool: { description, index: 'map' } })`: the app's own `docs` tool description, and `docs({})` as a plain-text map grouped by section. The default index stays the JSON list.
- core: `outbound()`'s `deps.fetch` is a production transport seam, its contract stated on `OutboundFetch`: it is handed the screened url and `redirect: 'manual'`, and the deadline, byte cap and redirect rules stay `outbound()`'s. A transport that follows a redirect itself is refused with the new `X_OUTBOUND_TRANSPORT_REDIRECTED` (502, terminal, no `meta.status`), under `redirect: 'error'` and `'follow'` alike: no screen saw that hop ([Outbound HTTP → transport](wiki/Outbound-HTTP.md#depsfetch-the-transport)).
- `DataTable` and `Board` select rows with `selection`: a native checkbox per row posting its key in one form with scripting off, Shift+click ranges, the ARIA grid pattern's keys, long press on a touch card, on `DataTable` only a tick-all header box when `selection.onChange` is set, and `BulkBar` — a sticky bar with the caller's actions, a live count when `selection.onChange` is set, and an "all matching" box that posts the list's filter, never a list of ids. A row that leaves the list leaves the selection. New `ui.selection.*` catalog keys.
- mcp: `mcpClient({ maxBytes })` and `mcpTools({ maxBytes })` cap one answer read off the wire (default 16 MiB); past it the call is `X_MCP_REMOTE_REFUSED`, `meta.failure: 'transport'`, source `X_OUTBOUND_TOO_LARGE`. Their `fetch` is documented as a production transport under `outbound()`.
- `@ultimat3/mcp`: URL-mode elicitation on a JSON answer (MCP 2026-07-28). A handler returns `withUrlElicitation(output, { url, message })`; a modern `tools/call` whose `_meta` declares `elicitation.url` is answered `resultType: 'input_required'` with one `elicitation/create` request under `inputRequests.url_elicitation`, and its retry carrying `inputResponses.url_elicitation` gets the tool's result. Every other caller, legacy included, gets the tool's result as before. A URL that is not absolute `https:` (`http:` on this machine), carries credentials or has no message is `X_MCP_ELICITATION_URL_INVALID`.

### Fixed
- The exercise pass installs the boot's fleet-wide auth limiter (`postgresAuthLimiter` over its scratch database), so an app declaring `defineAuth({ rateLimit: { scope: 'shared' } })` no longer sees every exercised action that reserves an attempt refused with `X_AUTH_LIMITER_NOT_SHARED`.
- `update` and `updateWhere` of a row that breaks an entity's CHECK invariant answer `X_INVARIANT_VIOLATED` naming the rule (a 422), as `insert` of the same row does. Before, the server's `23514` reached the caller as `X_DB_STATEMENT_FAILED`, a 500. A CHECK the entity does not declare is unchanged, and so is one on another table (a trigger's write) that shares a rule's name: a db error's `meta` now carries the failing `table`.
- `@ultimat3/mcp` recipes in sections: a link's whole path is checked (`docs://ref/errors/old` no longer passes as `docs://ref/errors`); `docs({ uri })` matches the URI as written (`docs://recipes/ref/errors` is not `docs://ref/errors`); a title's line breaks no longer split its `index: 'map'` line; a quoted alias may hold a comma; on POSIX a `\` in a recipe file name is read as part of that name, never as a separator. `replayRecipes(…, { sections })` names the server's other sections, so a subset replay reads links into them. `X_MCP_RECIPE_URI_RESERVED`'s fix parses, and `X_MCP_RECIPE_LINK_DANGLING`'s cause names any section, not only `docs://recipes/`, and at replay says the caller could not read the link rather than that no recipe serves it. A dotted suffix is part of a link (`docs://ref/errors.html`); a markdown recipe body keeps its first line's indentation; an alias splits only at commas outside quotes.
- `@ultimat3/auth`: on a store implementing the new optional `revokeLiveGrant` (the memory and Postgres stores do), two racing `revokeGrant({ subject, grantId })` calls on one grant count it once — one answers 1, the other 0; on a store without it, both may answer 1, as before. A store wrapping another's `revokeGrant` wraps `revokeLiveGrant` too, since the per-grant revoke calls it when set. `revokeLiveGrant(id, at)` is one conditional write answering whether that call ended the grant, and `authServerStoreConformance` holds a store that implements it. `grants()` answers copies, so editing a listed `createdAt` or `scopes` no longer edits a memory store's row; the memory store's `liveGrants` skips the token scan when the subject has no matching unrevoked grant, and otherwise collects liveness only for those grant ids. Its docs say what listing reads — stored token expiry and retirement, not a lifetime recomputed or a client's current permission — and that `grantId` names a `client_credentials` grant too.
- `x i18n sync <locale>` keeps every app catalog on one key set when a mounted admin derives keys the default locale answers from the framework's own `en` (`admin.brand.name`, a framework table's fields): the keys it writes to `<locale>` are also written to the default locale's catalog, with the string that locale already renders, and `--json` lists them as `defaultAdded`. Before, they landed in `<locale>` alone and the scaffold's "same keys as the default" test went red on the fix `X_CATALOG_MISSING_KEYS` names.
- The client scope id names the tenant: an actor with an `orgId` gets a different `<meta name="ultimate-scope">` per org, so the same person in two orgs no longer shares the page's record store, persisted rows or queued writes across them, and a soft GET no longer swaps a page rendered in one org into a document of the other (a POST that switches org and renders in place is still swapped in, then the tab empties every cache and stops swapping). An actor with no `orgId`, and the anonymous page, keep the id they had. After the upgrade, each signed-in tab whose actor carries an `orgId` makes one full load on its next navigation, because its scope changed (when that navigation is a POST that renders in place, its page is swapped in and the tab stops swapping, so the full load comes on the next link or form); that load is a principal change, so rows and offline writes the tab stored under the old scope are wiped, and a replay naming the old scope is refused with `X_REPLAY_PRINCIPAL_MISMATCH`. Two tabs of one browser in two orgs are now two principals, with the trade-off [Realtime](https://github.com/developerz-ai/ultimate/wiki/Realtime) states for two principals in two tabs.
- A unit test importing a module whose stylesheet calls Sass `asset()` (`url(asset('assets/fonts/x.woff2'))` in `global.scss`) no longer dies with `X_ASSET_MISSING` on a fresh app: `@ultimat3/testing/preload`, run from an app root, installs the app's own site asset table into `asset()` as the boot does, and again at every file boundary. A missing file is still `X_ASSET_MISSING`. The table moved to `@ultimat3/render/server` (`siteAssetTable`, `hashedAssetUrl`, `parseHashedAssetUrl`, `SITE_ASSETS_SOURCE`, `SITE_ASSET_BASE_PATH`, `ASSET_CONTENT_TYPES`, types `SiteAsset`, `SiteAssetTable`) so the test preload reads the same one.
- `@ultimat3/realtime`: a device that redials the same node before its first socket's registration lands keeps the newer socket — the first socket's late claim closed it as `replaced`.
- `x test e2e` (and the e2e pass of any `x test` run) drives a real browser: in an app root with Chrome found it runs under the e2e preload with the app root and device zone named, as `x verify --only e2e` does. Before, it never launched the app and every browser-backed case skipped.
- A soft visit to a `stream` page paints before its slowest hole: the client router reads the answer as it arrives, swaps the shell in at the server's flush mark, and fills each hole as its chunk lands, through the same reveal a full load runs. A newer navigation cancels the request, so the server stops the holes' work. Measured in Chrome on a page with holes at 300 ms, 1 s and 2 s: the shell paints at 65 ms p95, against 2,041 ms before. The router grows by 1,949 B minified (691 B gzip), charged to every route on a surface with client navigation; a stream page with holes writes a 14-byte comment after its shell and after each hole.
- Isolated test runs no longer retain one global object per file on Bun 1.4.6+: the runtime now clears finished files' plugins at the isolation swap, so the framework's `Bun.plugin.clearAll()` workaround is skipped from that version on while older Bun keeps it.
- `navigation: 'document'` on a page whose surface is not in `app.config.ts` `navigation.client` boots: it asks for the full-document load such a surface already gives, so it is honoured instead of refused with `X_ROUTE_NAVIGATION_INVALID`. Every other mode there is still refused.
- `@ultimat3/testing`: `RenderedView.text` (`renderView`, `renderRoute`) decodes character references as documented: every numeric one (`&#39;`, `&#x2019;`) and the common named ones (`&quot;`, `&apos;`, `&nbsp;`, typographic quotes and dashes, `&hellip;`, `&copy;` …), in one pass. It decoded only `&lt;`, `&gt;` and `&amp;`, so copy with an apostrophe or a quote never matched its `t('<key>')`. As a browser reads them: a numeric reference and a legacy name (`&amp`) need no semicolon, `&#128;`–`&#159;` are windows-1252 (`&#128;` is `€`), and a no-break space is kept, not collapsed. A null, a surrogate or a code point past Unicode reads as U+FFFD; an unknown name stays as written.
- `x drill roll-before-migrate` retries a role that lost its port before migrate: an outgoing Postgres connection could take a handed-out port before the role bound it, and the role's EADDRINUSE exit read as a failed drill.
- `defineAuth({ passkeys: { origins } })` refuses an origin whose host is not a DNS name — `https://*.example.com` included — with `X_CONFIG_INVALID`. A browser sends one exact origin, so a wildcard matched nothing and every ceremony failed.
- `x upgrade`'s `merge-drivers` codemod and `x g` no longer write a second `queries` / `jobs` / `tasks` key into a `defineApi({ ... })` that already names it as a shorthand (`queries,`) or a non-list value: a list is added only when the call names no such key (31.49.0 wrote `queries: []` beside `queries,`, TS1117).
- `x upgrade` codemods keep a rewritten file's mode: 31.49.0's `merge-drivers` turned an executable `bin/setup.ts` into a plain file.

- `x upgrade`'s `merge-drivers` codemod reports the setup step it cannot place: in an app whose `bun run setup` is not `bin/setup.ts` (a bash `bin/setup`), `skipped` now names the script `package.json` runs, or `package.json` itself, with the line to add (`bunx x merge-driver install`). Before, the step was in neither `changed` nor `skipped`, and the drivers were never installed.
- `@ultimat3/notify`: a native push's `sound`, `category` and `channelId` take their documented characters (`A-Za-z0-9._-`) in every position, so `channelId: '_mentions'` sends instead of failing the whole push; `X_NOTIFY_PUSH_MESSAGE_INVALID` for a native field now prints a `fix:` that parses (the notifier's `message` with that field set), and calls an interruption level what it is, one of APNs' fixed values. Docs: an unset `sound` requests none (APNs alerts silently, Android 8+ plays the channel's), FCM reads a `res/raw` name without the extension, and a credential refusal rejects the send, so `NativePushReport.skipped` counts only devices with no provider configured.
- `x upgrade` no longer drops an app under its coverage floor with no behaviour change: when the `merge-drivers` codemod puts `apps/web/api/index.ts` one entry per line and no `index.test.ts` sits beside it, it writes `apps/web/api/index.test.ts`, which checks that each listed primitive is registered under its export name (`x new` has shipped its own version of this test since 2026-10). An index that exports no `api` is reported in `skipped`.
- `x upgrade` no longer stops a hop on `X_COVERAGE_FLOOR_STALE`, which means the tree now covers more than its floor. The hop raises each `x.verify.json` `coverage` number to the larger of its floor and the measured whole percent (it never lowers one, and a floor reaching 95 drops its `why`), re-runs `unit`, and judges again. The raise is in `--json` as `coverageRaised` and on one terminal line.
- `@ultimat3/testing`: `renderRoute` honours a routed locale prefix in its `url`, as the router does: `{ url: 'https://x/es/' }` renders `load`, `meta` (`locale`, `t`) and the page in `es` when `es` is one of the app's locales, inside a request context that also holds `actor` when one is given. It rendered every URL in the default locale, so a test of a localized page needed `runWithContext(ctxOf({ locale }), …)` around it. An unprefixed URL, or a first segment that is no routed locale, opens no context of its own: standalone it is the default locale, and inside a caller's `runWithContext` it is that context's.
- The `X_BUDGET_EXCEEDED` fix says to run `x manifest` after raising a route's budget: `x.manifest.json` carries the budget, and a raise without it failed CI with `X_PROJECTION_DRIFT`.

### Added

- `@ultimat3/mcp`: `defineAppMcp({ tenant: { discover, optional } })`. `discover` names a tool the server already serves (`list_resources` on a `'meta'` or `'meta-split'` surface, or an ungrouped tool of `tools:`) to list the tenants in place of `list_tenants`, which is then not registered: called with no tenant argument it answers the tenant list, called with one it is the tool it always was. `optional` names ungrouped tools that run as the person when a call names no tenant and as the tenant actor when it names one. `tools/list` marks the argument required only where a call without it is refused, and `X_MCP_TENANT_REQUIRED` points at the discover tool. A wrong name is `X_MCP_TENANT_INVALID` at boot. A server that sets neither is unchanged.

- `@ultimat3/mcp`: on a `'meta-split'` surface `delete_resource` is the stricter door. A `write` action sent to it is previewed and confirmed as a delete is, where it was `X_MCP_WRONG_TOOL`; `write_resource` and `read_resource` are not widened. `defineAppMcp({ split: { fields, stricter } })` adds the app's own string fields to the dispatcher envelopes (validated there, handed to a hand-written tool or a `runtimeTool` as `door.fields`, never part of the action input) and a hook that sends one call to `delete_resource` by its arguments: `X_MCP_WRONG_TOOL` naming `delete_resource` on the other two dispatchers, and the one way a read runs there. The audit line and `onAudit` carry the dispatcher a call came through (`door`). New code `X_MCP_SPLIT_INVALID` at boot.

### Changed

- The scaffold pins `@biomejs/biome` 2.6.6, and every tracked `biome.json` `$schema` moves with it, so a new app lints with the same formatter this repository runs.

## Releases

| Version | Date | Summary |
|---|---|---|
| [31.49.0](docs/changelog/31.49.0.md) | 2026-11-20 | **Processes per container:** a production container can run several processes on one port, so `web`, `sync` and `worker` roles use the cores they are given. Set by `ULTIMATE_PROCESSES`; an upgrade changes nothing until a container declares a CPU budget. |
| [31.48.0](docs/changelog/31.48.0.md) | 2026-11-19 | **Many agents, one machine:** heavy commands reserve their measured memory in one machine-wide ledger and share a local core cap, so parallel agents queue instead of swamping the box. `x heavy status` shows who runs and who waits. |
| [31.47.1](docs/changelog/31.47.1.md) | 2026-11-18 | **`x upgrade` leaves an old app green:** an app with pages but no `site/page.tsx` gets a working e2e suite or a stated skip, `test-ports` moves both files or neither, old scaffold guard copies are recognised, and re-running at the target version changes nothing. |
| [31.47.0](docs/changelog/31.47.0.md) | 2026-11-18 | **The finish sweep (plan 101):** a replayed offline write is bound to the principal that queued it, the gate's `exercise` step gives the same verdict for the same code, scaffolded apps run their full CI weekly and open one issue on a scheduled failure, and every known gap, stub and exemption now carries a decision or is gone. |
| [31.46.0](docs/changelog/31.46.0.md) | 2026-11-18 | **One redirect path for a browser's form (D10):** the sign-in and invite actions `x g sign-in` and `x g invite` write answer a native form post through `native:` alone, and the hand-written `landAt()` helper is gone. The generated tests now post a real form through the HTTP pipeline. A fresh saas app gates green with no `X_NATIVE_FORM_UNANSWERED`. |
| [31.45.0](docs/changelog/31.45.0.md) | 2026-11-18 | **Faster, steadier CI, and what the adopter rollout taught:** |
| [31.44.0](docs/changelog/31.44.0.md) | 2026-11-17 | **Audit rounds 5 and 6 (plan 101b, slice 20), security first:** |
| [31.43.0](docs/changelog/31.43.0.md) | 2026-11-17 | **Audit round 4 (plan 101b, slice 20):** OAuth client-metadata fetches are metered for every caller; presence leave frames fit the client's frame limit; the `assets.retain` sweep no longer deletes a file another pod's publish reused; `x upgrade` survives a reused pid; scaffold CI pins every action by SHA; one env declaration form, `envSchema`. Each fix has a test that failed first. |
| [31.42.1](docs/changelog/31.42.1.md) | 2026-11-17 | **An s3 disk on R2 (or any endpoint) works in its default addressing:** the Bun client reached the account root instead of the bucket, so reads, lists and `assets.retain` failed unless `S3_FORCE_PATH_STYLE=1` was set. |
| [31.42.0](docs/changelog/31.42.0.md) | 2026-11-17 | **The gate's `live` step holds a strict floor to its word:** a `live` test that skipped with the database in reach is red, and a runner with no database stays a warning. The signal travels through `--json` to `x verify merge`. |
| [31.41.0](docs/changelog/31.41.0.md) | 2026-11-17 | **Audit round 3 (plan 101b, slice 20), its P2s:** `x dev`'s rebuild, the schema wait under an early SIGTERM, the test-services stack for older apps, and the docs the auditors falsified, plus three regressions an adopter's upgrade surfaced. Each fix has a test that failed first. |
| [31.40.1](docs/changelog/31.40.1.md) | 2026-11-17 | **Audit round 3 (plan 101b, slice 20), its security half:** the realtime channel tenant leak (P0) and two P1s, each with a test that failed first. The round's P2s follow in the next release. |
| [31.40.0](docs/changelog/31.40.0.md) | 2026-11-17 | **Audit round 2 (plan 101b, slice 20):** six read-only auditors (bugs in the unread tiers, concurrency, security on injection and secrets, a DX pass, an architecture review). Every confirmed finding is fixed, each with a test that failed first. Counts: P0 0 · P1 6 · P2 22 fixed (the DX pass by real use: 2 P1, 10 P2), plus 2 P2 parked for the next major or deferred to round 3. |
| [31.39.0](docs/changelog/31.39.0.md) | 2026-11-17 | **Audit round 1 (plan 101b, slice 20):** four read-only auditors, production evidence and the open issues. Every confirmed finding is fixed, each with a test that failed first. The security fix ships separately in 31.38.1. |
| [31.38.1](docs/changelog/31.38.1.md) | 2026-11-16 | **Security: live queries no longer cross tenants on a tenant column not named `orgId`.** Upgrade; no code change needed. |
| [31.38.0](docs/changelog/31.38.0.md) | 2026-11-16 | **Eight app shapes, each gated twice in CI.** `x new <name> --shape saas \| agent \| realtime \| content \| offline` join `api`, `dashboard` and `blog`: |
| [31.37.0](docs/changelog/31.37.0.md) | 2026-11-16 | **CI is faster where it was slowest.** Shards are dealt on measured per-file time, with 4 unit shards and 3 live shards: the slowest unit part went from 415 s to 315 s on CI. |
| [31.36.0](docs/changelog/31.36.0.md) | 2026-11-16 | **A fix line opens with what to paste or run.** 917 `fix:` lines across every package and the repository scripts opened with a sentence; 862 now open with a command, a code shape (`policy: '<resource>:<verb>'`, `assertCurrency('USD')`, `` sql`…` ``) or an `edit <file>:<line> — …`, with the old instruction after it as a comment. The 55 that remain carry a reason per package in `scripts/lib/fix-prose-pins.ts`: a remedy that is judgement, or one at a call site the thrower cannot see. |
| [31.35.0](docs/changelog/31.35.0.md) | 2026-11-16 | **The error reference is an index plus one page per owner**, as the changelog is. `wiki/Error-Codes.md` was one 627 KB page of 1,358 rows. It is now: |
| [31.34.0](docs/changelog/31.34.0.md) | 2026-11-16 | **A test states its own verdict with `expect`, never a bare `Error`** (plan 101b slice 12 M6, third PR). 80 sites where a test threw a bare `Error` to fail itself now use `expect.unreachable` or a direct assertion: `realtime`, `http`, `query`, `db`, `entity`, `seo`, `cli`, `jobs`, `testing`, `admin`, `ai`, `auth`, `render` and `ui`. Several were silently weak, a throw the subject or the test's own handler swallowed, and are stronger now: `auth`'s JWKS "never asked for a key", `ai`'s SSE frame count. Every remaining pinned site is an INPUT, a stub that throws at the subject, and its row says what it simulates. |
| [31.33.0](docs/changelog/31.33.0.md) | 2026-11-16 | **Every shipped source file opens with its 1–4 line responsibility header, and every `node:` import says why Bun cannot do the job** (plan 101b slice 12 M6, second PR). The `source-headers` pin table is empty: 316 rows fell. `node-imports` fell from 173 explained-or-not sites to 0. Where Bun has the same API, the import is gone instead: `Bun.CryptoHasher` in `@ultimat3/entity`'s seed ids (pinned by a known-answer test against an independent uuid5), `Bun.file().exists()` in four `x verify` readers, and `Bun.Glob` and `Bun.pathToFileURL` in tests. |
| [31.32.0](docs/changelog/31.32.0.md) | 2026-11-16 | **The security and robustness ratchets are burned down** (plan 101b slice 12 M6). Every site eight guards pinned across `cli`, `scripts` and every package was repaired, or keeps one row with a permanent written reason. Done by the guards' own repair, never a dodge: |
| [31.31.0](docs/changelog/31.31.0.md) | 2026-11-16 | **The `next` lane runs itself up to the merge.** `next-sync.yml` merges `main` into `next` weekly. `scripts/release-due.ts` reports `data.nextLane`: once the major window is open and `next` is green and ahead, it proposes the `chore: release X.0.0` PR, which a person merges. `scripts/next-breaks.ts` renders the tracking issue of every parked break, cited at the line that parked it. |
| [31.30.0](docs/changelog/31.30.0.md) | 2026-11-16 | **Test determinism.** One helper per flake class in `@ultimat3/testing` and one guard per unsafe form, each pin table empty: |
| [31.29.0](docs/changelog/31.29.0.md) | 2026-11-15 | A deploy no longer crash-loops when roles start before migrate: a serving role whose framework schema or app migrations are behind its build **waits** (jittered backoff, one log line, `/healthz` 200 and `/readyz` 503 on its own port), serves once the migrate step lands, and exits with `X_FRAMEWORK_SCHEMA_UNAPPLIED` / `X_APP_MIGRATIONS_UNAPPLIED` after `ULTIMATE_SCHEMA_WAIT_MS` (default 5 minutes; `0` refuses at once). |
| [31.28.0](docs/changelog/31.28.0.md) | 2026-11-15 | `x upgrade` carries an app's scaffold files forward with **codemods**: every scaffold-owned change between your version and the target is applied, and a file you edited is listed with its diff and never overwritten. Apps scaffolded at 31.4, 31.15, 31.20 and 31.22 reach 31.28.0 with no hand edit (`scripts/upgrade-fixtures.ts`, run in CI). |
| [31.27.0](docs/changelog/31.27.0.md) | 2026-11-15 | `x verify` cannot pass on a skipped step: every step that ran no check is listed as `skipped: <reason>` (`data.skipReasons`), and `x.verify.json` gains `strict` — with `strict: true` every step must run a check or carry a written `skip` why (`X_VERIFY_STRICT_UNRUN`); without it, a warning names the steps an app never runs. New scaffolds are strict and run `live` against real Postgres and `e2e` in a real browser. |
| [31.26.0](docs/changelog/31.26.0.md) | 2026-11-15 | `llm()` and `agent()` take `fallbackModels`: an ordered list tried on a declared failure class (rate limited, overloaded, timeout, unavailable), every attempt billed at its own model's price and traced under one span; and a typed `providerOptions` bag, validated per wire before any request. |
| [31.25.0](docs/changelog/31.25.0.md) | 2026-11-15 | `limiter(name, { rate, concurrency })` is a named fleet budget every job naming it spends (`job({ limiter })`); a run over it is deferred, never dead-lettered. |
| [31.24.0](docs/changelog/31.24.0.md) | 2026-11-15 | A policy `scope` takes `or`, `and` and `via` (a hop into another entity, `col in (select …)`), compiled to one statement and tenant-scoped inside every hop — `andWhereNode()` on the chain; a custom driver declares `predicate:or` / `predicate:via` or is refused. |
| [31.23.0](docs/changelog/31.23.0.md) | 2026-11-14 | A retried job attempt no longer pages: it counts on `jobs_retried_total{job,code}`, and only a dead letter reaches the error tracker, once, as `error`. A job opts its retries back in with `retry: { report: 'every-attempt' }`. |
| [31.22.3](docs/changelog/31.22.3.md) | 2026-11-14 | The Redis cache bus never unsubscribes a channel its connection already holds, so a peer's invalidation sent while a node boots is no longer lost (#1132). |
| [31.22.2](docs/changelog/31.22.2.md) | 2026-11-14 | `x dev` holds a stale module pin until the process restarts, so a second save tick never reports "reloaded" over a read still serving the old service, and `/_x` keeps `X_DEV_RESTART_REQUIRED` until the restart. |
| [31.22.1](docs/changelog/31.22.1.md) | 2026-11-14 | `postgresAuditSink({ groupCommit: true })` sends each batch outside any caller's transaction, so one request's rollback no longer loses other requests' audit rows. |
| [31.22.0](docs/changelog/31.22.0.md) | 2026-11-13 | Agent tooling: the format hook `x new` writes now runs (it read a variable Claude Code never sets); the dev MCP server gains `docs.search`, `db.explain`, `requests.statements` and `verify.narrow`; `x docs` answers task phrasing. |
| [31.21.0](docs/changelog/31.21.0.md) | 2026-11-13 | `x verify`'s `drift` step warns `X_DB_INDEX_UNDECLARED` for an index in the schema dump that neither the newest migration snapshot nor any entity declares — the shape that hid seven duplicate indexes in production. A warning in 31.x. |
| [31.20.0](docs/changelog/31.20.0.md) | 2026-11-13 | Security: a revoked, expired or forged session no longer keeps its live-query socket streaming after sign-out, and a stale session cookie no longer answers 401 on every route. Existing apps are protected by upgrading; the `x new` and `x g sign-in --oidc` templates return `null` for a session refusal. |
| [31.19.0](docs/changelog/31.19.0.md) | 2026-11-13 | A release commit no longer cold-installs on every CI job: the bun cache is keyed on the packages `bun.lock` resolves, not the whole file. |
| [31.18.1](docs/changelog/31.18.1.md) | 2026-11-13 | `x exercise` on a large app is about a quarter faster (494 s → 380 s on a 487-primitive app): the seed solver no longer re-tries every parent earlier tenants took, crash-proof id renaming is one pass, and the frozen clock no longer throws per bound string. Findings, verdicts and seed graphs are unchanged. |
| [31.18.0](docs/changelog/31.18.0.md) | 2026-11-13 | The admin search ignores case and reads four resources at a time; a declared row scope stays case-sensitive, because it is authorization. |
| [31.17.0](docs/changelog/31.17.0.md) | 2026-11-13 | New commands: `x token` (API keys), `x config show` (redacted), `x logs tail`, `x cache graph\|bust\|clear`, and `x explain <query>` (plans what a query actually sends, never against production). |
| [31.16.0](docs/changelog/31.16.0.md) | 2026-11-13 | `x exercise` is fairer and stricter: a refused test-seed table is one finding instead of every check going unproven, one call is held to 100 statements (loops declared with `expectedQueryLoop` excluded), and a data-dependent branch no longer reads as an N+1. `x.verify.json` `exercise.unprovenMax` / `statementsMax` floors are red when declared, warnings otherwise. |
| [31.15.0](docs/changelog/31.15.0.md) | 2026-11-12 | An island whose render throws keeps its server HTML instead of going blank (`mountOver`, used by `x g island`, `x new` and the resource form; the `island-mount-clears` guard finds older islands). |
| [31.14.0](docs/changelog/31.14.0.md) | 2026-11-12 | A deploy no longer reloads every live query: a replicator that stops cleanly hands over to its successor (change envelope v2), so sync nodes keep their windows; a crash still re-reads, once. Roll sync nodes before the replicator to get it on the first roll. |
| [31.13.1](docs/changelog/31.13.1.md) | 2026-11-12 | Security: the framework's lockfile resolves `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Not reachable through `@ultimat3/render` — `sass` declares it but never loads it — so an app needs only `bun update source-map-js` to clear `bun audit`. |
| [31.13.0](docs/changelog/31.13.0.md) | 2026-11-12 | An idle job queue costs a quarter of what it did: a worker on two queues, the outbox relay and the scheduler leader send 543 statements an hour, down from 2,418 — workers rest until the next due row instead of claiming every 5 s, counters are batched, and lease renewals are HOT updates. |
| [31.12.0](docs/changelog/31.12.0.md) | 2026-11-12 | A page no longer stays unstyled after one stylesheet fails during soft navigation: the router does a full load instead of swapping in a page whose CSS did not load, and keeps the previous sheets. |
| [31.11.0](docs/changelog/31.11.0.md) | 2026-11-12 | Security: a `native:` form answer and `uploadFlow` are host- and row-guarded — a refused form never redirects off this host, and an upload's policy judges the row it attaches to. |
| [31.10.0](docs/changelog/31.10.0.md) | 2026-11-12 | Security: `subjectErase` now reaches `<table>_history` — every image naming the erased person is purged in the parent's transaction, including rows deleted earlier and images a `set null`/`cascade` write records. An undeclared history table is `X_SUBJECT_TABLE_UNDECLARED`. |
| [31.9.0](docs/changelog/31.9.0.md) | 2026-11-12 | Set-based entity writes: `db.x.where(…).updateAll(patch)` / `.deleteAll()` is one statement, and `updateMany([{ id, patch }])` writes 1,000 different rows in one statement. |
| [31.8.0](docs/changelog/31.8.0.md) | 2026-11-12 | A rate-limit check writes no WAL: `x_rate_limit` is unlogged at fillfactor 70 (2 WAL records per take → 0). |
| [31.7.0](docs/changelog/31.7.0.md) | 2026-11-12 | Security: a sealed column no longer enters a history image (its lookup ciphertext was an equality oracle), and the authorization server enforces each client's registered grants and auth method. |
| [31.6.1](docs/changelog/31.6.1.md) | 2026-11-11 | After a deploy, a CDN can no longer hand a page an island chunk from the previous build: every island and `/_x/assets` script is named by a hash of its final bytes (#1075). |
| [31.6.0](docs/changelog/31.6.0.md) | 2026-11-11 | `contract-diff` compares against the manifest as committed, so `x manifest` or `x g` can no longer rebaseline a breaking change away before the gate sees it. |
| [31.5.0](docs/changelog/31.5.0.md) | 2026-11-11 | One address no longer meets 429 on a cold page load: built, content-hashed assets spend a new `assets` rate-limit bucket (2,000 burst, 200/s) instead of `default`. Measured: 180 of 300 island-chunk GETs from one address answered 429 before, 0 after. |
| [31.4.2](docs/changelog/31.4.2.md) | 2026-11-11 | `launchChrome` no longer gives up on a cold Chrome that has already opened its debugging port: the connection now gets what is left of the 60 s launch deadline, not the 10 s per-call one. |
| [31.4.1](docs/changelog/31.4.1.md) | 2026-11-11 | An island that throws an app error code ships about half the bytes: import `defineError` from `@ultimat3/core/page` (12,019 B → 6,507 B). |
| [31.4.0](docs/changelog/31.4.0.md) | 2026-11-11 | `ROLE=migrate` loads 104 fewer modules (977 → 873): the framework schema now reads the auth tables from the new `@ultimat3/auth/schema` leaf instead of the whole auth package. |
| [31.3.0](docs/changelog/31.3.0.md) | 2026-11-11 | Read one row's recorded history in write order with `history(db.postsHistory, id)`: versions numbered from 1, scoped to the tenant. |
| [31.2.0](docs/changelog/31.2.0.md) | 2026-11-10 | `x build` and `x exercise` honour `runtime.ts`: an audit sink declared there makes audited pages measurable and audited primitives reachable. |
| [31.1.0](docs/changelog/31.1.0.md) | 2026-11-10 | `x affected`, `x verify --changed` and `x test --affected` measure a change against `origin/main` by default, not a local `main` nobody pulled, and `bun test $(x affected --paths)` receives only paths. |
| [31.0.0](docs/changelog/31.0.0.md) | 2026-11-10 | **v31 is the stable line.** 74 breaking changes — most delete a second way to do one thing, the rest are security fixes and limits — each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading#30x--3100-entry-by-entry). The next major comes no earlier than 2027-02-08, 90 days from today ([Stability](https://github.com/developerz-ai/ultimate/wiki/Stability)). |
| [30.9.0](docs/changelog/30.9.0.md) | 2026-11-09 | The test network seal is whole: every DNS resolver, `node:net`/`tls`/`http(s)`/`http2` and UDP are refused unless loopback, mocked or allowed — a test that reached the internet through one of them now fails, and `allowHost('<host>')` is the fix it prints. |
| [30.8.0](docs/changelog/30.8.0.md) | 2026-11-08 | Every primitive of a real app can be reached by `x exercise`: an entry can carry its call's cookies and headers, a job and an action of one name get separate entries, and a throwing entry is that primitive's record instead of the end of the pass. |
| [30.7.0](docs/changelog/30.7.0.md) | 2026-11-08 | `x exercise` runs at the size of a real app. A crash proof costs the same over 1,500 seeded rows as over 3: one job's proof cost a 504-primitive app most of a 172-minute pass. Every record and the report now say where the time went. |
| [30.6.0](docs/changelog/30.6.0.md) | 2026-11-08 | `x exercise` counts a job's own statements: never the jobs it queued, never jobs it found queued. A job that queues one child per row is no longer `X_QUERY_SCALES_WITH_ROWS`. |
| [30.5.0](docs/changelog/30.5.0.md) | 2026-11-08 | `x exercise` reports what a 5xx said, seeds a NOT NULL `json(t.json())` column, resolves mocked hosts under the sealed network, and names the step a crash-proof effect ran inside. |
| [30.4.0](docs/changelog/30.4.0.md) | 2026-11-07 | `x exercise` runs vendor-calling handlers for real under the sealed network: `defineExercise(overrides, { setup })` installs an app's `mockFetch` routes or `cassette()` for the pass. |
| [30.3.0](docs/changelog/30.3.0.md) | 2026-11-07 | `x exercise` seats a job in the tenant it is enqueued under, whatever field its `tenant(input)` reads: no more `X_JOB_TENANT_MISMATCH` (and `X_TENANCY_ACTOR_MISMATCH` inside) on a job whose org field the id binder did not recognise. |
| [30.2.0](docs/changelog/30.2.0.md) | 2026-11-07 | `seo: { llms: false }` hands `/llms.txt` to the app: an app serving its own no longer fails to boot with `X_ROUTE_CONFLICT`. |
| [30.1.0](docs/changelog/30.1.0.md) | 2026-11-07 | `x exercise` seeds a table with your own `defineFactory`, so an entity whose rows no generated value satisfies — a cross-column `satisfies`, a JSON column with required keys — runs the gate's `exercise` step. |
| [30.0.0](docs/changelog/30.0.0.md) | 2026-11-07 | One major for the whole of plan 101: every breaking change below lands here once, each with its edit in [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading). |
| [29.4.0](docs/changelog/29.4.0.md) | 2026-10-31 | Added · Changed |
| [29.3.2](docs/changelog/29.3.2.md) | 2026-10-31 | Added · Fixed |
| [29.3.1](docs/changelog/29.3.1.md) | 2026-10-30 | Fixed |
| [29.3.0](docs/changelog/29.3.0.md) | 2026-10-30 | Added · Fixed |
| [29.2.0](docs/changelog/29.2.0.md) | 2026-10-30 | Added · Changed |
| [29.1.0](docs/changelog/29.1.0.md) | 2026-10-29 | Added · Changed |
| [29.0.0](docs/changelog/29.0.0.md) | 2026-10-28 | Added · Changed · Fixed |
| [28.0.0](docs/changelog/28.0.0.md) | 2026-10-24 | Changed · Added · Fixed |
| [27.16.1](docs/changelog/27.16.1.md) | 2026-10-24 | Fixed |
| [27.16.0](docs/changelog/27.16.0.md) | 2026-10-23 | Added · Fixed |
| [27.15.0](docs/changelog/27.15.0.md) | 2026-10-22 | Added · Fixed |
| [27.14.1](docs/changelog/27.14.1.md) | 2026-10-22 | Fixed |
| [27.14.0](docs/changelog/27.14.0.md) | 2026-10-22 | Added · Fixed |
| [27.13.2](docs/changelog/27.13.2.md) | 2026-10-21 | Fixed |
| [27.13.1](docs/changelog/27.13.1.md) | 2026-10-20 | Fixed |
| [27.13.0](docs/changelog/27.13.0.md) | 2026-10-20 | Added · Fixed |
| [27.12.0](docs/changelog/27.12.0.md) | 2026-10-18 | Added · Changed |
| [27.11.0](docs/changelog/27.11.0.md) | 2026-10-17 | Fixed |
| [27.10.4](docs/changelog/27.10.4.md) | 2026-10-15 | Fixed |
| [27.10.3](docs/changelog/27.10.3.md) | 2026-10-15 | Fixed |
| [27.10.2](docs/changelog/27.10.2.md) | 2026-10-14 | Fixed |
| [27.10.1](docs/changelog/27.10.1.md) | 2026-10-12 | Fixed |
| [27.10.0](docs/changelog/27.10.0.md) | 2026-10-12 | Added · Changed · Fixed |
| [27.9.0](docs/changelog/27.9.0.md) | 2026-10-11 | Added · Fixed |
| [27.8.1](docs/changelog/27.8.1.md) | 2026-10-11 | Fixed |
| [27.8.0](docs/changelog/27.8.0.md) | 2026-10-11 | Added · Fixed |
| [27.7.0](docs/changelog/27.7.0.md) | 2026-10-10 | Fixed |
| [27.6.1](docs/changelog/27.6.1.md) | 2026-10-10 | Fixed |
| [27.6.0](docs/changelog/27.6.0.md) | 2026-10-10 | Added · Fixed |
| [27.5.0](docs/changelog/27.5.0.md) | 2026-10-10 | Added · Fixed |
| [27.4.0](docs/changelog/27.4.0.md) | 2026-10-09 | Added · Fixed |
| [27.3.0](docs/changelog/27.3.0.md) | 2026-10-09 | Added · Fixed |
| [27.2.3](docs/changelog/27.2.3.md) | 2026-10-09 | Fixed |
| [27.2.2](docs/changelog/27.2.2.md) | 2026-10-09 | Fixed |
| [27.2.1](docs/changelog/27.2.1.md) | 2026-10-09 | Fixed |
| [27.2.0](docs/changelog/27.2.0.md) | 2026-10-09 | Added · Fixed |
| [27.1.0](docs/changelog/27.1.0.md) | 2026-10-09 | Added |
| [27.0.0](docs/changelog/27.0.0.md) | 2026-10-09 | Changed · Added · Fixed |
| [26.1.1](docs/changelog/26.1.1.md) | 2026-10-08 | Fixed |
| [26.1.0](docs/changelog/26.1.0.md) | 2026-10-08 | Added · Fixed |
| [26.0.0](docs/changelog/26.0.0.md) | 2026-10-08 | Changed · Added |
| [25.2.0](docs/changelog/25.2.0.md) | 2026-10-07 | Added · Fixed |
| [25.1.0](docs/changelog/25.1.0.md) | 2026-10-07 | Added · Fixed |
| [25.0.0](docs/changelog/25.0.0.md) | 2026-10-07 | Added · Security · Changed · Fixed |
| [24.0.0](docs/changelog/24.0.0.md) | 2026-10-04 | Added · Changed · Fixed |
| [23.0.0](docs/changelog/23.0.0.md) | 2026-10-02 | Added · Changed · Fixed · Removed |
| [22.15.0](docs/changelog/22.15.0.md) | 2026-10-01 | Added · Changed · Fixed |
| [22.14.0](docs/changelog/22.14.0.md) | 2026-09-30 | Added |
| [22.13.0](docs/changelog/22.13.0.md) | 2026-09-29 | Added · Changed · Fixed |
| [22.12.0](docs/changelog/22.12.0.md) | 2026-09-29 | Added · Fixed |
| [22.11.0](docs/changelog/22.11.0.md) | 2026-09-29 | Changed · Added · Fixed |
| [22.10.0](docs/changelog/22.10.0.md) | 2026-09-29 | Added · Changed |
| [22.9.1](docs/changelog/22.9.1.md) | 2026-09-29 | Fixed |
| [22.9.0](docs/changelog/22.9.0.md) | 2026-09-29 | Added · Fixed |
| [22.8.2](docs/changelog/22.8.2.md) | 2026-09-28 | Fixed |
| [22.8.1](docs/changelog/22.8.1.md) | 2026-09-28 | Fixed · Added |
| [22.8.0](docs/changelog/22.8.0.md) | 2026-09-28 | Added · Changed |
| [22.7.1](docs/changelog/22.7.1.md) | 2026-09-28 | Fixed |
| [22.7.0](docs/changelog/22.7.0.md) | 2026-09-28 | Changed · Added · Fixed |
| [22.6.2](docs/changelog/22.6.2.md) | 2026-09-27 | Fixed |
| [22.6.1](docs/changelog/22.6.1.md) | 2026-09-27 | Fixed |
| [22.6.0](docs/changelog/22.6.0.md) | 2026-09-27 | Added · Changed · Security |
| [22.5.1](docs/changelog/22.5.1.md) | 2026-09-27 | Security |
| [22.5.0](docs/changelog/22.5.0.md) | 2026-09-27 | Added · Fixed |
| [22.4.0](docs/changelog/22.4.0.md) | 2026-09-27 | Added · Fixed |
| [22.3.6](docs/changelog/22.3.6.md) | 2026-09-26 | Fixed |
| [22.3.5](docs/changelog/22.3.5.md) | 2026-09-26 | Fixed |
| [22.3.4](docs/changelog/22.3.4.md) | 2026-09-26 | Fixed |
| [22.3.3](docs/changelog/22.3.3.md) | 2026-09-26 | Security · Fixed |
| [22.3.2](docs/changelog/22.3.2.md) | 2026-09-26 | Fixed |
| [22.3.1](docs/changelog/22.3.1.md) | 2026-09-26 | Added · Changed · Fixed |
| [22.3.0](docs/changelog/22.3.0.md) | 2026-09-25 | Added · Changed · Fixed |
| [22.2.2](docs/changelog/22.2.2.md) | 2026-09-25 | Added · Fixed |
| [22.2.1](docs/changelog/22.2.1.md) | 2026-09-25 | Fixed |
| [22.2.0](docs/changelog/22.2.0.md) | 2026-09-24 | Added · Fixed |
| [22.1.0](docs/changelog/22.1.0.md) | 2026-09-24 | Changed · Security · Fixed |
| [22.0.0](docs/changelog/22.0.0.md) | 2026-09-24 | Changed · Added · Fixed |
| [21.0.0](docs/changelog/21.0.0.md) | 2026-09-23 | Added · Fixed · Changed |
| [20.2.1](docs/changelog/20.2.1.md) | 2026-09-19 | Changed · Fixed |
| [20.2.0](docs/changelog/20.2.0.md) | 2026-09-19 | Added · Fixed |
| [20.1.6](docs/changelog/20.1.6.md) | 2026-09-18 | Fixed |
| [20.1.5](docs/changelog/20.1.5.md) | 2026-09-18 | Fixed |
| [20.1.4](docs/changelog/20.1.4.md) | 2026-09-18 | Added · Fixed |
| [20.1.3](docs/changelog/20.1.3.md) | 2026-09-18 | Fixed |
| [20.1.2](docs/changelog/20.1.2.md) | 2026-09-16 | Changed · Fixed |
| [20.1.1](docs/changelog/20.1.1.md) | 2026-09-12 | Fixed |
| [20.1.0](docs/changelog/20.1.0.md) | 2026-09-12 | Added · Changed · Fixed |
| [20.0.0](docs/changelog/20.0.0.md) | 2026-09-08 | Added · Changed · Fixed |
| [19.4.0](docs/changelog/19.4.0.md) | 2026-09-08 | Added |
| [19.3.3](docs/changelog/19.3.3.md) | 2026-09-07 | Added |
| [19.3.2](docs/changelog/19.3.2.md) | 2026-09-07 | Added · Fixed |
| [19.3.1](docs/changelog/19.3.1.md) | 2026-09-06 | Fixed |
| [19.3.0](docs/changelog/19.3.0.md) | 2026-09-06 | Removed · Fixed |
| [19.2.0](docs/changelog/19.2.0.md) | 2026-09-06 | Added · Changed · Fixed |
| [19.1.3](docs/changelog/19.1.3.md) | 2026-09-06 | Fixed |
| [19.1.2](docs/changelog/19.1.2.md) | 2026-09-06 | Fixed |
| [19.1.1](docs/changelog/19.1.1.md) | 2026-09-05 | Fixed |
| [19.1.0](docs/changelog/19.1.0.md) | 2026-09-05 | Fixed · Changed · Not changed, and the evidence for why |
| [19.0.0](docs/changelog/19.0.0.md) | 2026-08-27 | Added · Fixed · Changed · Not changed, and the evidence for why |
| [18.0.0](docs/changelog/18.0.0.md) | 2026-08-27 | Added · Changed · Fixed |
| [17.0.0](docs/changelog/17.0.0.md) | 2026-08-26 | Added · Changed · Fixed · Removed |
| [16.0.0](docs/changelog/16.0.0.md) | 2026-08-26 | Added · Fixed · Changed |
| [15.0.0](docs/changelog/15.0.0.md) | 2026-08-25 | Fixed · Changed · Known |
| [14.0.0](docs/changelog/14.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [13.0.0](docs/changelog/13.0.0.md) | 2026-08-25 | Added · Fixed · Changed |
| [12.0.0](docs/changelog/12.0.0.md) | 2026-08-24 | Security · Fixed · Added · Removed · Changed |
| [11.3.0](docs/changelog/11.3.0.md) | 2026-08-24 | Fixed · Added · Changed |
| [11.2.0](docs/changelog/11.2.0.md) | 2026-08-23 | Added · Fixed · Changed |
| [11.1.0](docs/changelog/11.1.0.md) | 2026-08-23 | Added |
| [11.0.0](docs/changelog/11.0.0.md) | 2026-08-23 | Added · Changed · Fixed |

## Older releases

`10.0.0` and everything before it are **in git history, not in this file**. No length cap is
enforced: trimming is a deliberate edit that deletes the oldest `## X.Y.Z` sections, because a
changelog nobody scrolls to the bottom of is a changelog nobody reads, and every deleted line is
one `git show` away.

| Want | Run |
|---|---|
| one past release's section | `git show v10.0.0:CHANGELOG.md` — or any tag; every release from 1.0.0 on is tagged |
| when a line was written, and by whom | `git log -p --follow -- CHANGELOG.md` |
| the whole file as it stood at the last full release | `git show v13.0.0:CHANGELOG.md` |
| what a major broke, without git | [`wiki/Upgrading.md`](https://github.com/developerz-ai/ultimate/wiki/Upgrading) — it walks **every** major, oldest first, and is deliberately NOT truncated |

**The upgrade guide is the one that has to stay complete**, and it does: a reader upgrading across
four majors needs every walkthrough in order, where a reader of this file wants the last release.
Two documents, two jobs — `bun run changelog-check` reads the oldest `## X.Y.Z` heading still here
as the retention boundary and stops demanding a section below it, so trimming this file again is
deleting sections and nothing else.
