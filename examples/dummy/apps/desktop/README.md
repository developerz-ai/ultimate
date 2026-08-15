# apps/desktop — placeholder

Empty on purpose. A desktop build is a shell around the same app, added without moving a file.

## Tauri

Not built yet. As of 2026-08 the CLI has no `x app add` and no `x build --target desktop` — both are
milestone 12 on the roadmap ([`docs/idea/16-app-targets.md`](../../../../docs/idea/16-app-targets.md)),
which is why this directory stays empty rather than holding a scaffold nothing generates. The
shape is already decided, so it is written down here instead of guessed at again when it ships:

Wraps `apps/web`'s `app/` surface in a Tauri window:

| Piece | Where it comes from |
|---|---|
| UI | the existing `app/` routes — no second component tree |
| Data | the same typed client against a configured `APP_URL` |
| Offline | the tier-3 persisted store already in `liveFeed`, so the desktop app is offline-capable on day one |
| Auth | the same Better Auth session, stored in the OS keychain instead of a cookie jar |
| Updates | Tauri's updater, keyed on the same immutable build id the web app uses |

## Why not Electron

Both work. Tauri is the blessed path because it reuses the system webview instead of shipping a
browser, which keeps the download in the tens of megabytes and matches [axiom 7] — the desktop
build is packaging, not a second product.

## What changes in the code

Almost nothing, and that is the point:

| Concern | Change |
|---|---|
| `site/` | not shipped — the desktop app has no marketing surface |
| `render` modes | `stream` and `ssr` fall back to `spa` when the shell is local |
| Deep links | one route table entry per `postly://` scheme handler |
| Filesystem | a `route` with a policy, like any other capability |

## Rules

- No desktop-only business logic. If it needs a rule, it goes in `packages/core`.
- No desktop-only authz. The policies are the app's policies.
- Ship it from the same CI as the containers; one build id, one manifest, one truth.
