# apps/mobile — placeholder

Empty on purpose. The monorepo is shaped so a native app is an addition, not a restructure.

## What is already reusable

| From | You get |
|---|---|
| `packages/domain` | the same types, roles, plan catalog and invariants — no I/O, so it compiles anywhere TypeScript runs |
| `apps/web/api` (types only) | the typed action/query surface, and `openapi.json` generated from it |
| `packages/i18n` | the same `en` + `es` catalogs, so the app and the phone say the same thing |
| `x.manifest.json` | every route, action, policy and MCP tool, machine-readable, regenerated each build |

Nothing in `packages/` imports the DOM, `Bun.serve`, or a route. That is the property that makes
this directory cheap to fill.

## Swift

```bash
x sdk swift --out apps/mobile/ios/PostlyKit
```

Generates a Swift package from `openapi.json`: one method per action, typed request and response
structs, and the same error codes (`X_FORBIDDEN`, `X_BILLING_SEATS_EXCEEDED`) as an enum.
Auth is the same session cookie or bearer token the web app uses — Better Auth issues both.

## Kotlin

```bash
x sdk kotlin --out apps/mobile/android/postly-kit
```

Same contract, same codes.

## What does **not** come for free

| Concern | Why |
|---|---|
| Offline store | tier 3 persistence is IndexedDB in the browser; a native client needs SQLite behind the same mutator contract |
| Live queries | the WS protocol is documented and stable, but there is no native client library yet |
| Push | `pwa.push` covers web push only; APNs/FCM is app work |

## Rules

- The phone calls **actions**. It does not talk to Postgres, and it does not get its own endpoints.
- A rule the phone needs goes into `packages/domain` or `packages/core`, never into the app twice.
- Regenerate the SDK in CI from `openapi.json`; a hand-edited SDK is drift with extra steps.
