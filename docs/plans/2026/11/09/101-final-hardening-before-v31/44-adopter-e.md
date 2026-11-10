# 44 — Adopter E: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter E's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
29.4.0 on main + a mail patch; branch `chore/ultimate-30` at 30.8.0 with red CI; **deployed on the cluster**

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. Delete `patchedDependencies` (`package.json:75-77`), `patches/@ultimat3%2Fmail@29.4.0.patch`, `apps/web/shared/mail-smtp-starttls.test.ts`: the STARTTLS fix shipped in #982; close its issue tracking the patch.
4. After [`17`](17-cli-runtime.md) C5, [`08`](08-http.md) H9, [`16`](16-notify-pwa-scraping.md) N3 ship: delete `apps/admin/app/admin/href.ts:17-27` (locale-prefixed admin), `apps/web/app/login/next-locale.ts` (locale-aware sign-in redirect), the hash code in `apps/web/pwa-install.ts:15-20` (screenshots through `asset()`). Update its framework-gaps section in `CLAUDE.md`.
5. Its `exercise` step went red repeatedly on the 30.x branch: use [`17`](17-cli-runtime.md) C9 output.
6. Worker config: queues `['default']` ([`17`](17-cli-runtime.md) C3) — the `queue-unregistered` warning is in its production logs.
7. Its Sentry MCP config and ops error wiring: move to the framework Sentry hooks ([`02`](02-core-schema.md) K5).
8. Add the scaffolded `.github/dependabot.yml` grouping if absent ([`17`](17-cli-runtime.md) C6).
9. `bun run verify` (`x verify`) green; open a PR; CI green; merge.
10. Production: roll, then check pod logs and `pg_stat_statements` (reset after rollout, [`26`](26-infra.md) F7).

## Done when
- The adopter pins 31.0.0 with no patch, no restated framework constant and no workaround this plan made obsolete; its gate is green on `main`.

## Outcome (2026-11-10)
Done. Run from this adopter's own repository, in a git worktree. The coordinator did the production roll.

| Step | Result |
|---|---|
| upgrade to 31.0.0, then 31.2.0 | done; 31.2.0 picks up the field-report fixes listed in [`39`](39-v31-release.md#outcome-2026-11-10) |
| step 10, the roll | done. `NATS_URL` added before the roll (infra PR #2254); `LIVE_NATS_URL` dropped after it (#2258); the old queue confirmed empty |
| verified | pods on the new image, logs clean, sign-in redirect checked |
| `pg_stat_statements` | reset for this adopter's database only ([`26`](26-infra.md) F7) |
| SSO route rename (#52) | the identity provider's allowed redirect URIs updated for three clients, in its config repo (PRs #58, #59). Since 31.2.0, `oauthLogin({ callbackPath })` keeps an already-registered URI |
