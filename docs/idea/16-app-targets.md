# App targets

Three targets, one backend, **two view layers** — and the second one is admitted, not hidden.

Web is SolidJS + SCSS modules. Desktop is that same build inside a Tauri window. Mobile is React
Native, which shares no component with either. Everything *below* the view is shared on all three.

Planned for **1.1.0**, `As of 2026-08`. Every change here is additive — two new packages, two new
`x build --target` values, one optional field on `route` — so no major. This lifts
[`14-roadmap.md`](./14-roadmap.md)'s "mobile/desktop app targets beyond placeholders" out of the
deferred column.

## What is shared, and what is not

| Layer | web | desktop | mobile | Shared? |
|---|---|---|---|---|
| `entity`, `policy`, `action`, `mutator`, `query`, `job`, `task` | ✅ | ✅ | ✅ | one declaration, server-side, unchanged |
| the typed client (`rpc()`) | ✅ | ✅ | ✅ | `client.ts` already has no server imports |
| `openapi.json`, `x.manifest.json`, contract-diff | ✅ | ✅ | ✅ | one contract |
| `X_*` codes + `application/problem+json` decoding | ✅ | ✅ | ✅ | one error vocabulary |
| i18n catalogs, `t()` | ✅ | ✅ | ✅ | one flat file per locale, as today |
| `Money`, `formatMoney`, `formatDateTime` + IANA rule | ✅ | ✅ | ✅ | tier-1 packages, no DOM |
| **design tokens** (colour roles, space, radius, type, motion) | ✅ | ✅ | ✅ | the seam — see below |
| `route` declarations: path, policy, offline, deep link | ✅ | ✅ | ✅ | one route table |
| **the view** (components, styles, layout) | Solid + SCSS modules | *same as web* | React Native + `StyleSheet` | ❌ |
| navigation / router | `@ultimat3/render`'s router | same | RN navigation | ❌ |
| render modes (`static`/`isr`/`ssr`/`stream`) | ✅ | `spa` only | none | ❌ |
| SEO, sitemap, feeds, OG images | ✅ | — | — | ❌ — no crawler on a phone |
| PWA `sw.js`, precache, web push | ✅ | — | — | ❌ |
| CSS itself: cascade, `:has()`, media queries, logical properties | ✅ | ✅ | ❌ | RN has no CSS |

### What a user accepts writing twice

| Written twice | Why it cannot be one thing |
|---|---|
| Every screen with a mobile target | `<div class={s.card}>` and `<View style={s.card}>` are different renderers over different layout engines; no compiler bridges them without inventing a third dialect nobody debugs |
| The navigation graph | a URL bar and a native stack have different back semantics, different transitions, different lifecycles |
| Platform-idiomatic interactions | pull-to-refresh, swipe-back, haptics, sheets — the reason to be native at all |

Written **once**, and this is the whole bet: the entity, the policy, the action, the query, the job,
the i18n key, the money format, the error code, the route path, the token. A screen is markup over
data it did not fetch and rules it did not decide.

### Tokens are the seam

`packages/ui/src/tokens/tokens.ts` already exists as *"a typed mirror of the SCSS token source, for
consumers that cannot read CSS"* — built for charts, `<canvas>`, OG images and email. React Native is
one more consumer that cannot read CSS. The seam is there; it is at the wrong tier.

| Form | Consumer |
|---|---|
| `_colors.scss` etc. — canonical | web + desktop stylesheets |
| `tokens.ts` — mirror, drift-tested | charts, canvas, OG images, mail |
| `StyleSheet` values, derived from `tokens.ts` | React Native |

One canonical source, three projections, one drift test. A colour that exists on the phone and not
on the web is a failing test, not a design review.

## No ninth primitive

A **screen is a `route`.** Not a new kind of thing, and not a factory over one.

`llm()` is a factory because a model call has authoring ergonomics — prompt, model, evals — that
would bloat `action()` for every non-model caller. A target list is one enum field. So `route` gains
one optional field and there is still exactly one way to declare a route:

```ts
route({
  path: '/dashboard',        // the directory, as today
  targets: ['web', 'mobile'], // default: ['web']
  render: 'stream',
  policy: { permission: 'app:read' },
});
```

| Question | Answer |
|---|---|
| Where does a screen attach? | `route` — it already owns path, policy, offline behaviour, budget |
| Where does an **app target** attach? | nowhere in the primitive set. A target is a build artifact: `x build --target` |
| A native capability the server must trust (payment, upload, device registration)? | an `action`. Server-authoritative, one policy, one contract |
| A purely local capability (open the camera, read a photo)? | a function call in the view layer, which is per-platform by definition. Not a primitive |
| A push notification? | a `job`. Durable, retried, enqueued through the outbox — the same shape `mail` already has |
| The OTA update endpoint? | a `route` in `api/`, serving from the `storage` seam |

Enforced, not documented:

| Rule | Code |
|---|---|
| `targets` includes `mobile`, no `screen.tsx` in the mirrored directory | `X_SCREEN_MISSING` |
| a `screen.tsx` whose route does not declare `mobile` | `X_SCREEN_ORPHANED` |
| any module importing both `solid-js` and `react`/`react-native` | `X_VIEW_RUNTIME_MIXED` |

The third one is the important one: it protects **app** code, not just framework packages. A
`page.tsx` importing an RN component, or a `screen.tsx` importing `@ultimat3/ui`, is a build error
before it is a bundle.

## Packages

Two. Not five.

| Package | Tier | Imports | Earns its line because |
|---|---|---|---|
| `@ultimat3/tokens` | **1** | `core` | the one thing two view layers must agree on. It cannot stay in tier-5 `ui`: a tier-4 native runtime cannot import upward, and dragging 41 Solid components onto a phone to reach a colour is the opposite of the point. `core` is its only import, so tier 1 is the lowest its real imports allow — the same rule that placed `db` |
| `@ultimat3/native` | **4** | `core`, `schema`, `tokens`, `i18n`, `money`, `time`, `storage`, `http`, `action` | the device runtime (client wiring, secure-storage session, token→`StyleSheet` bridge, error rendering, update client) **and** the Expo Updates server endpoint. `realtime` is the precedent for one package owning both halves of one protocol |

`@ultimat3/native` sits at tier 4 as the **peer of `render`**, and never imports it. That is the
guarantee, not a comment: `render` holds server rendering over `Bun.serve`, and nothing reachable
from a Metro bundle may reach it. It reads the route table through `core`'s registrar
(`primitiveRegistrar('route')`) — the same seam `defineApi` uses to reach `query` and `jobs`
without a sideways import.

`ui` (5) → `native` (4) is a *downward* edge, which the tier rule would allow. It must not be
allowed. `scripts/lib/tiers.ts` gains a `FORBIDDEN` map alongside `SIDEWAYS_ALLOW`, with one entry
earning its line: `ui ✗ native`.

### Packages deliberately not created

| Not created | Instead |
|---|---|
| `@ultimat3/desktop` | Tauri is packaging, not a product. A build target plus a scaffold template in `cli`. Zero runtime code |
| `@ultimat3/native-ui` | the framework ships **no native component kit** in 1.1. See *Risks* — this is the scope cut that decides whether this ships at all |
| `@ultimat3/push` | APNs/FCM is a transport seam inside `native`, driven by a `job`, symmetric with `mail` |
| `@ultimat3/ota` | the protocol server is 300 lines over `storage` + `http`; a package for it is a second place to look for one update |

### The tokens move is not breaking

`@ultimat3/ui` re-exports `@ultimat3/tokens` **verbatim** — the precedent is `action` re-exporting
`t` from `schema`, with an identity assertion in `index.test.ts`. Existing imports keep working, so
1.1.0 holds.

## CLI

| Command | Behaviour |
|---|---|
| `x new <name> --targets web,mobile,desktop` | default `web`. Named targets scaffold a real `apps/mobile` / `apps/desktop`, not a README |
| `x app add mobile\|desktop [--json]` | adds a target to an existing project |
| `x build --target native --platform ios\|android [--store] [--json]` | without `--store`: the JS bundle + assets + signed update manifest (runs on Linux/CI). With `--store`: shells out to Xcode/Gradle for the binary |
| `x build --target desktop [--platform macos\|windows\|linux] [--json]` | Tauri bundle; `--platform` defaults to the host |
| `x ota publish --channel <name> [--rollout <pct>] [--json]` | uploads bundle + assets to the `storage` seam, signs the manifest, flips the channel |
| `x ota rollback [--channel <name>] [--json]` | previous update becomes current; no store round-trip |
| `x ota status [--json]` | channel, current update id, runtime version, rollout percentage |
| `x dev --target native` | starts the app server **and** the RN bundler pointed at it — one loop, one build id |
| `x doctor` | grows Xcode / Android SDK / Rust+Tauri checks, each with a runnable `fix:` |

`BUILD_TARGETS` grows from three to five: `docker | binary | static | native | desktop`. `--platform`
is one new flag shared by the two new targets. Every value still names an **artifact class**, which
is what kept the enum readable at three.

`x ota`, not `x update` — the planned `x upgrade` moves `@ultimat3/*` versions, and two commands one
character apart is the ambiguity axiom 1 exists to delete.

New codes, each with a fix and a docs page: `X_SCREEN_MISSING`, `X_SCREEN_ORPHANED`,
`X_VIEW_RUNTIME_MIXED`, `X_OTA_RUNTIME_MISMATCH`, `X_OTA_CHANNEL_UNKNOWN`,
`X_NATIVE_TOOLCHAIN_MISSING`.

`x verify` grows exactly two steps — `screens` and `view-runtime`. Token drift stays the unit test it
already is, and the native client's build-id check folds into the existing `contract-diff` step,
because a client holding build A calling a server on build B *is* contract drift and already has a
code (`X_CONTRACT_DRIFT`).

## OTA: the Expo Updates protocol, served by your own app

**Recommendation: bare-workflow React Native with the `expo-updates` client, against an update
endpoint the framework ships and the user hosts.** One way, no vendor.

| Candidate | Rejected because |
|---|---|
| **Expo Updates protocol, self-hosted** | ✅ chosen |
| EAS Update as a required dependency | a vendor primitive in the framework — [axiom 7](./00-thesis.md) |
| CodePush | App Center retired; never a published spec |
| Shorebird | Flutter |
| A protocol of our own | two native client implementations to maintain forever, on platforms this repo has no business owning |

Why the Expo protocol is a spec and not a vendor API — the load-bearing claims, `As of 2026-08`:

| Claim | Evidence |
|---|---|
| It is a published specification, explicitly addressed to "organizations that wish to manage their own update server" | [Expo Updates v1 spec](https://docs.expo.dev/technical-specs/expo-updates-1/) |
| Independent conformant servers exist | Expo's own reference [`custom-expo-updates-server`](https://github.com/expo/custom-expo-updates-server); [XPREM / expo-open-ota](https://github.com/axelmarciano/expo-open-ota), MIT core, self-hosted, "your bucket, your CDN, your data", v3 released 2026-07 |
| The client verifies updates with **the developer's own key**, so host, CDN and ISP cannot tamper | `expo-expect-signature` / `expo-signature`, `rsa-v1_5-sha256` — [code signing](https://docs.expo.dev/eas-update/code-signing/) |
| `expo-updates` works in a bare project without adopting the managed workflow | `expo` + `expo-modules-core` install into existing `ios/`/`android/` folders |

The framework's contribution: an `api/` route implementing the manifest response, assets served from
`@ultimat3/storage` (S3, MinIO, or a local directory — the same seam everything else uses), and
signing with a key from the typed env. Nothing knows the name of a cloud. Using EAS instead remains
possible precisely *because* the client is standard — that is the user's choice, made outside the
framework, exactly like choosing Hetzner over Fly.

### What OTA can and cannot update

| Change | Ships OTA | Needs a store submission |
|---|---|---|
| TypeScript in `apps/mobile/**` | ✅ | |
| Bundled assets — images, fonts, i18n catalogs | ✅ | |
| A new `action` the phone calls | ✅ | |
| Design tokens | ✅ | |
| A JS-only npm dependency | ✅ | |
| Any Swift or Kotlin file | | ❌ |
| A new native module or config plugin | | ❌ |
| A new permission, `Info.plist` / `AndroidManifest` change | | ❌ |
| React Native or Expo SDK bump | | ❌ |
| App icon, display name, splash | | ❌ |

Apple permits updating interpreted code but not materially changing the app's purpose (guideline
3.3.1) — so the table above is the *technical* boundary, and "don't ship a different product over
the air" is the policy one.

### How custom Kotlin/Swift coexists with OTA

Custom native code is written with the **Expo Modules API** — Swift and Kotlin in the project, no
ejecting, callable from JS. The binary owns the native surface; the OTA bundle owns the JS surface.
The line between them is the **runtime version**.

| Rule | Consequence |
|---|---|
| Runtime version is a **fingerprint of the native surface**, not the app version | adding a Kotlin module changes it; changing a screen does not |
| A bundle built for runtime version N is never served to a binary at N−1 | the protocol's own guarantee, and the reason a JS bundle cannot call a native module the installed binary lacks |
| `x ota publish` recomputes the fingerprint and **refuses** when it moved | `X_OTA_RUNTIME_MISMATCH`, fix: `x build --target native --platform ios --store` |

Without that refusal, the failure is a crash on a user's device, discovered from a store review. With
it, it is a build error on the machine that made the change — [axiom 3](./00-thesis.md), applied to
the one place where "we can ship anytime" is false.

## Desktop: Tauri

Tauri 2.x (2.10.1, `As of 2026-08`) is frontend-agnostic, so Solid needs no adapter. The desktop
build is packaging, and the doc that already says so is
[`examples/dummy/apps/desktop/README.md`](../../examples/dummy/apps/desktop/README.md) — this section
makes it real.

| Piece | Where it comes from |
|---|---|
| UI | the existing `app/` client bundle, `spa` projection. No second component tree |
| `site/` | not shipped — a desktop app has no marketing surface. The existing surface boundary, reused |
| Data | the same `rpc()` client against a configured `APP_URL` |
| Auth | the same session, stored in the OS keychain instead of a cookie jar |
| Deep links | one `myapp://` scheme handler per route, from the same route table |
| Filesystem, tray, menu, autostart | Tauri plugins, allowlisted in the generated config. The framework ships the config, never a wrapper API |
| Updates | `tauri-plugin-updater`: signed bundles at an HTTPS endpoint, verified before the binary is swapped. Same channel, same build id, same `x ota publish --target desktop` |

`stream` and `ssr` are server render modes; a local shell has no server, so the desktop build takes
the `spa` projection of every `app/` route and nothing else changes.

**Not Tauri for mobile**, though Tauri 2 supports iOS and Android:

| Reason | Detail |
|---|---|
| The updater plugin is desktop-only, `As of 2026-08` | it is excluded on Android and iOS — adopting Tauri for mobile forfeits the OTA promise, which is the stated reason mobile exists |
| A webview app cannot host idiomatic Swift/Kotlin | the second stated reason mobile exists |
| Review risk | a wrapped-website iOS app is the archetype reviewers reject |

## Project layout

```
tesote.ai/
  apps/
    web/{site,app,api,shared}/       # unchanged
    admin/                           # unchanged
    mobile/
      app/                           # MIRRORS apps/web/app/ directory-for-directory
        dashboard/screen.tsx
        posts/[id]/screen.tsx
      native/{ios,android}/          # Swift / Kotlin — the store-versioned half
      metro.config.ts
    desktop/
      src-tauri/{tauri.conf.json,Cargo.toml,src/}
  packages/
    domain/                          # pure types, no I/O — compiles on a phone today
    db/  i18n/  mcp/
    ui/                              # Solid components (web + desktop)
    native-ui/                       # the app's own RN components. Peer of ui/, never imports it
  app.config.ts                      # still ONE config: gains `targets` and `ota`
  x.manifest.json                    # GENERATED — routes now carry their target list
```

| Rule | Reason |
|---|---|
| **The directory is the route on every target** | `apps/web/app/posts/[id]/page.tsx` and `apps/mobile/app/posts/[id]/screen.tsx` are one route. A URL, a deep link and a native screen share one path, and the pairing is checkable |
| `apps/mobile/app/` is a mirror, not a co-location | Metro must not walk `.scss` files and Bun must not walk RN modules. [Axiom 6](./00-thesis.md) generalises: **each target's bundle graph is its own tree** |
| `packages/domain` is untouched | it already has no I/O; that property is what makes this cheap |
| No mobile-only business rule, no mobile-only authz | a rule the phone needs goes in `domain` or an `action` |

The mirror can drift. That is why `screens` is a gate step and not a convention.

## Staging

Roadmap milestones 12–14. Each ends in the same demo app advanced visibly plus a green gate — a
milestone is done when the gate covers it, never when the code exists.

| # | Milestone | Ships | Done when |
|---|---|---|---|
| 12 | **Desktop** | `x build --target desktop`, Tauri scaffold + config template, keychain session, `tauri-plugin-updater` wiring | the demo app runs on macOS and Linux from the same `app/` bundle; an update is applied without a reinstall; `x build --target desktop` smoke-tested in CI |
| 13 | **Shared core + mobile runtime** | `@ultimat3/tokens` (t1), `@ultimat3/native` (t4), `route.targets`, `screen.tsx`, the `screens` and `view-runtime` gate steps | the demo dashboard renders on a device against the same actions, the same policy denial, the same catalogs, with tokens provably identical to the web; a missing `screen.tsx` fails `x verify` |
| 14 | **OTA + native code** | the Expo Updates endpoint over `storage`, code signing from typed env, `x ota publish/rollback/status`, runtime-version fingerprint, one custom Kotlin/Swift module in the demo app | a JS-only fix reaches an installed device in under a minute with no store round-trip; a fixture whose native fingerprint moved is **refused** by `x ota publish`, and that refusal is a gate test |

Desktop lands first because it is the cheapest and it proves the load-bearing claim — that a target
can be packaging rather than a second product — before anything spends effort on a second view layer.

| Deferred | Why |
|---|---|
| Native push (APNs/FCM) | a `job` + a transport seam; nothing about it is blocked by 12–14 |
| Offline writes on device (tier 3) | already deferred for web; a native SQLite store behind the same mutator contract is the same work, twice postponed |
| A native realtime client | the WS protocol is stable and documented; a device library is not the bottleneck for a first mobile app |
| `x sdk swift\|kotlin` | **recommend deleting the promise.** Under this design the phone's client is TypeScript over the same `rpc()`. A generated Swift SDK is a second client for the same contract, and OpenAPI generators already exist |
| Tauri for mobile | never — see above |
| Store submission automation | never — a vendor primitive by any other name |

## Risks

| Risk | Honest size |
|---|---|
| **A second view layer is a permanent tax** | `@ultimat3/ui` is 41 components. A matching native kit is 41 more, forever, and every future component is two. The 1.1 answer to "give me a Button on both" is **no** — tokens and a runtime, not a kit. That cut is the difference between this shipping and not |
| **Two screens, one behaviour, no check** | `screens` catches a *missing* file. Nothing catches a mobile screen that quietly does something different. An agent asked to "fix the dashboard" will fix one of them. Unsolved |
| **React inside a Solid framework** | [`01-stack.md`](./01-stack.md) locks one choice per layer; this is the first second choice. Defensible — no Solid renderer for iOS/Android has adoption — but agents now have to know which target they are in, and `X_VIEW_RUNTIME_MIXED` is the only thing stopping that from being a guess |
| **Metro is Node** | the first Node dependency in a build path in a Bun-only repo. `x dev --target native` and `x build --target native` shell out to it. A written exception, not a quiet one |
| **The Expo protocol is specified by one company** | multiple independent servers implement v1, and our half is small — but a v2 is theirs to declare. Mitigation: the server is ours, so a protocol bump is a package change, not an app change |
| **Store review still gates the thing that matters** | OTA fixes JS. The first native module makes every subsequent native change a multi-day round-trip, permanently. Teams who internalise "we can ship anytime" and then add a native dependency are the ones `X_OTA_RUNTIME_MISMATCH` exists to protect |
| **`route.targets` is load-bearing forever** | additive today; a field an entire target reads is a field semver never lets us reshape |
| **The mirror drifts** | `apps/mobile/app/` mirroring `apps/web/app/` is a convention held up by one gate step. A rename on one side and not the other is a red build, which is the point, but it is friction on every routing change |

**What would make this a mistake:** if most users only ever wanted a PWA. Then two packages, a second
view layer and a fifth build target bought nothing, and the web path got slower to change to pay for
it. The trigger to reconsider is measurable — if the demo app's mobile screens stay in single digits
and `x ota publish` goes unused a year after 14 ships, `native` is deleted and `tokens` plus desktop
are kept. Both of those stand on their own.
