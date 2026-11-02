# 25 — Sign-in that a deployed app can actually use

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`auth`), 5 (`cli`).

## Why
A deployed scaffold issues no session: nothing calls `login()`, so every policy-protected route answers 401 (`wiki/Known-Gaps.md:41`).
Adopters fill it by hand. Three wrote sign-in; two SSO adopters hold near-copies, measured files and shared lines: `oidc` 169/137 (88 shared), `routes` 146/120 (60), `grants` 123/74 (39), `settings` 93/70 (39), `sso` 58/67 (19), `boot-guard` 47/48 (18). One records copying the other's workaround.
Those same two hand-write an external-issuer bearer for MCP: claims 89 and 86 lines, resolver 61 and 60, 78 differing lines across the claims pair. `verifyWorkloadToken` already does signature, issuer, audience and time (`packages/auth/src/workload.ts:79`), but throws and answers a `ServiceIdentity`, while `resolveToken` wants `{ actor, scopes } | null`. `apiKeyResolver` is that bridge for keys (`packages/auth/src/api-key-resolver.ts`); no twin exists for tokens.

## Files to change
- `packages/auth/src/workload.ts:34` — `WorkloadToken` also carries `raw`, the decoded payload, so an app can read its own claim after the signature held.
- `packages/auth/src/jwt-bearer-resolver.ts` — new, the twin of `api-key-resolver.ts`.
- `packages/auth/src/index.ts` — export it.
- `packages/cli/src/generate-kinds.ts:16` — `sign-in` in `GENERATORS`.
- `packages/cli/src/templates/sign-in-oidc.ts`, `sign-in-password.ts` — new app-owned templates.
- `packages/cli/src/cmd-generate-spec.ts` — `--oidc <provider>`, `--password`; exactly one.
- `wiki/Auth.md`, `wiki/MCP-And-AI.md`, `wiki/CLI-Reference.md`, `packages/auth/README.md`, `packages/auth/CLAUDE.md`, `packages/cli/README.md`.
- `wiki/Known-Gaps.md:41` — delete the row.

## Steps
1. `jwtBearerResolver({ keys, issuers, audience, requiredScope?, accept?, actorOf })` answers `(token) => Promise<{ actor, scopes } | null>`.
   - `keys` is a thunk, read when a token arrives: discovery opens no network at import.
   - `accept(raw)` is the app's own claim check after the signature. `actorOf(token)` builds the actor. Scope names and roles stay the app's (axiom 8).
   - Every refusal is `null` and one log line naming which check failed, never a claim's value. A key set that cannot be read is also `null`: both adopters fail closed, and an unknown `kid` looks the same.
2. `x g sign-in --oidc <provider>` writes, under `apps/web/app/auth/`: the flow over `discoverOAuthProvider` and `oauthLogin`, the routes for `runtime.routes` (start, callback, sign-out through `signOutHeaders()`), the sign-in page, settings in `app.config.ts`'s env, and the authenticator swap that deletes `dev-actor.ts`'s fallback line.
3. `x g sign-in --password` writes the page and action over `login()`, plus the second leg over `completeMfa`.
4. Both write a boot guard: outside `development` and `test`, a `web` or `sync` role with sign-in unconfigured refuses to start. Generated, app-owned, not a framework rule: an API-only app has no sign-in.
5. Generated output passes the app's `lint` and `typecheck` on the first run; a second `x g sign-in` refuses to overwrite.

## Error codes
`bun run new-error-code` for the one new code.
| Code | When | Fix |
|---|---|---|
| `X_AUTH_SIGN_IN_UNCONFIGURED` (new, off-socket) | the generated guard, a people-facing role with no sign-in settings outside dev and test | set the env keys `x env example` lists for sign-in |
| `X_UNAUTHENTICATED` (existing) | a refused bearer, rendered by the mount as its 401 | none on the server; the caller presents a valid token |

## Tests
- `packages/auth/src/jwt-bearer-resolver.test.ts`: right token gives an actor; wrong issuer, audience, expired, unsigned, failed `accept`, throwing key source each give `null`; the log line holds no token text.
- `packages/cli/src/generate-sign-in.test.ts`: both shapes write the listed files; a repeat run refuses.
- `packages/cli/e2e/sign-in.e2e.test.ts`: scaffold, `x g sign-in --password`, register, sign in, reach a policy-protected route over HTTP with no dev viewer. Fails today: 401.
- `scaffold-smoke` covers the generator; `scripts/generator-counts.ts` gets the new count.

## Semver
**Breaking, one row.** The exported `WorkloadToken` gains a required `raw`.
Upgrading: "A hand-built `WorkloadToken`, usually a test fake, adds `raw`, the decoded payload."

## Done when
- A scaffold reaches a protected route in a production environment after one generator command.
- An adopter's MCP resolver reduces to `jwtBearerResolver` plus its `accept` and `actorOf`.
- `wiki/Known-Gaps.md` no longer carries the 401 row.
