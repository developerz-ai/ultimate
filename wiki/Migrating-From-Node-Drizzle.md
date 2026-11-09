**Status: `not executed end to end`.** No Node/Drizzle app has been cut over by following this page yet; it flips to `executed` on evidence from an adopter's measured run.

# Migrating from Node and Drizzle

The concept map for a Node app on Drizzle ORM — Express, Fastify, Hono or Next.js route handlers in
front. The runbook — phases, exit conditions, stop conditions — is
[Migrating an existing app](Migrating-An-Existing-App); this page says what each term becomes.
`As of 2026-11` ([orm.drizzle.team](https://orm.drizzle.team/)).

## Concept map

| Node / Drizzle | Ultimate |
|---|---|
| an Express / Fastify / Hono route that renders | a route file: [Routes and render modes](Routes-And-Render-Modes) |
| a route handler that writes, a tRPC mutation | an `action`: [Actions](Actions) |
| a tRPC query, a GET handler | a `query`: [Queries and live queries](Queries-And-Live-Queries) |
| a `pgTable()` declaration | an `entity()`: [Entities and migrations](Entities-And-Migrations) |
| `drizzle-kit generate`, `migrate` | `x db gen "<name>"`, then `x db migrate` |
| a Zod schema on a handler | the action's `input`: [Actions](Actions) |
| BullMQ, pg-boss | a `job`: [Jobs and workflows](Jobs-And-Workflows) |
| `node-cron`, a repeatable job | a `task`: [Scheduled tasks](Scheduled-Tasks) |
| Passport, Auth.js, Lucia | [Auth](Auth) |
| CASL, hand-written middleware checks | a `policy`: [Policies and authz](Policies-And-Authz) |
| Socket.IO, `ws` | a live query: [Realtime](Realtime) |
| Nodemailer | [Mail](Mail) |
| S3 SDK calls | [Storage and uploads](Storage-And-Uploads) |
| Vitest, Jest | `bun test` through [Testing](Testing) |
| `node server.js`, `next dev` | `x dev` |

## What does not map

| Node / Drizzle | Why |
|---|---|
| Node-only APIs and native addons | Bun only: check each against Bun's own list, [bun.sh/docs/runtime/nodejs-apis](https://bun.sh/docs/runtime/nodejs-apis) |
| MySQL, SQLite (`mysqlTable`, `sqliteTable`) | Postgres only, by design: [Home](Home) |
| React components | pages render with SolidJS; interactive parts are islands. No converter |
| a serverless or edge deploy target | containers only: [Deployment](Deployment) |

## Schema adoption

Drizzle already declares tables in TypeScript, so the shape carries over column by column; ids are
whatever the app chose. Phase 1 of the runbook declares the existing tables with the physical-name
overrides and type map it gives, then `x db gen` until `x verify --only drift` agrees:
[Migrating an existing app](Migrating-An-Existing-App).

## Identity cutover

| The app stores | Branch |
|---|---|
| `bcrypt` / `bcryptjs` hashes (`$2a$`, `$2b$`) | **proceed**: verified natively, rewritten as argon2id on first login ([Migrating an existing app](Migrating-An-Existing-App)) |
| `argon2` hashes (`$argon2id$`) | **proceed**: rehashed when weaker than the policy |
| scrypt, PBKDF2, anything else | **⛔ stop**: no verifier ships. Keep the old login as a bridge, or force a reset |
| a JWT or a session table | bridge it with your own verifier behind `configureAuthenticator()` ([Auth](Auth)) |
