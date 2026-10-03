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
x manifest
bunx @openapitools/openapi-generator-cli generate -i openapi.json -g swift5 -o apps/mobile/ios/PostlyKit
```

`x manifest` writes `openapi.json`; an OpenAPI generator turns it into a Swift package with one
method per action and typed request and response structs. The CLI ships no SDK generator of its
own. Errors arrive as the same problem+json body the web app reads, `code` included (`X_FORBIDDEN`,
`X_BILLING_SEATS_EXCEEDED`). Auth is the same session cookie or bearer token the web app uses —
Better Auth issues both.

## Kotlin

```bash
x manifest
bunx @openapitools/openapi-generator-cli generate -i openapi.json -g kotlin -o apps/mobile/android/postly-kit
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
