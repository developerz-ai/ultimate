# Migrating an existing app

**A runbook for the agent doing the migration.** Ordered phases, each with an entry condition, executable steps, a machine-checkable exit condition, and a table of error codes to branch on. Strangler fig on one shared database — a big-bang rewrite is the topology that fails, and it is not documented here.

`As of 2026-08`. Source app: a production app on another stack — Rails, Node/Drizzle, Django, Laravel. This page is not about moving between Ultimate versions.

| You want | Page |
|---|---|
| move an app **from another framework** to Ultimate | this page |
| move an app **from `@ultimat3/*` 1.x to 2.0.0** | [Upgrading](Upgrading) |
| what is unfinished in the release being adopted | [Known gaps](Known-Gaps) |
| every `X_*` code named below | [Error codes](Error-Codes) |

## How to execute this page

| Rule | Detail |
|---|---|
| Every command takes `--json` | the envelope is `{ ok, command, summary, steps?, findings?, data? }`. **`.ok === true` is the postcondition** for every step below unless it says otherwise |
| A failure names a code | `.findings[].code` is a stable `X_*`. Branch on it by name; never on the summary string |
| An unrecognised code | `x errors explain <CODE> --json` → `.data.fix` is a runnable line. Run it, then re-run the failed step |
| A `x verify` failure | `.steps[]` carries `{ name, ok, findings[] }`. The failing step's `name` is the branch |
| A fork | is pre-decided below, with the condition under which the other arm applies. Where a genuine judgement is required, it is a **⛔ STOP** and you halt |
| Never invent a command | if a step names no command for a case, that case is a STOP |

## ⛔ Stop conditions — halt and report to the human

Do not perform these unattended. Each is irreversible, outward-facing, or a judgement no repository state can settle.

| # | Stop |
|---|---|
| 1 | **The production cutover** — routing live traffic to Ultimate for the first time |
| 2 | **Dropping, truncating or retyping any legacy table or column** — `x db gen` refuses without `--allow-destructive`; that refusal is the guard, do not pass the flag |
| 3 | **Deleting legacy source data** after a backfill, at any scale |
| 4 | **DNS, load-balancer or reverse-proxy configuration changes** |
| 5 | **Running any migration against production** — `ROLE=migrate` in a deploy hook is a human's release, not a step here |
| 6 | **Deciding which app owns DDL** when both still run migrations ([Phase 0, check 6](#6-who-owns-ddl)) |
| 7 | **Any preflight branch this page marks STOP** — a money column past the ceiling, a password scheme with no verifier, a required `vector` column |
| 8 | **Retiring the legacy slice** (Phase 7) |

Everything else here is safe to run against a **development or branch** database. `x db branch create <name> --json` gives you a disposable copy-on-write clone to work in.

## Where am I? — resuming with a fresh context

Determine the current phase from repository and database state alone. Run in order; the first row that does **not** hold is the phase to enter.

| Probe | Holds when | Else |
|---|---|---|
| `x doctor --json` → `.ok` | the app boots and its environment validates | fix what `.findings[]` names |
| `x entities --json` lists every table this slice owns | Phase 1 is done | **Phase 1** |
| `x db migrate --json` → `.ok` | no `X_DB_DRIFT` | **Phase 2** |
| `x verify --json` → `.ok` | the gate is green | **Phase 2** |
| a `configureAuthenticator()` call exists under `apps/` | a legacy session resolves to an `Actor` | **Phase 3** |
| `x queries --json` lists the slice's reads | Phase 4 is declared | **Phase 4** |
| `x actions --json` lists the slice's writes | Phase 5 is declared | **Phase 5** |
| `x db backfill --pending --json` → `.ok` | nothing declared is unswept | **Phase 6** |
| all of the above | | **Phase 7 — ⛔ STOP** |

If no `app.config.ts` exists at or above the working directory, every command answers `X_NOT_IN_APP`. Scaffold first: `x new <name>`.

---

## Phase 0 — Preflight

**Entry:** a connection to the legacy database; read-only is enough.
**Exit:** all seven checks answered, and none landed on a ⛔ STOP.

### 1. Money — magnitude

`MoneyValue.minor` is a JavaScript `number`. The ceiling is **`Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991 minor units** — roughly $90 trillion in USD cents. Past it the value is **refused, never truncated**.

Find the candidates:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (column_name like '%amount%' or column_name like '%price%'
    or column_name like '%cents%'  or column_name like '%total%'
    or column_name like '%minor%'  or column_name like '%balance%')
order by table_name, column_name;
```

Then, per hit:

```sql
select max(abs(<column>)) as biggest from <table>;
```

| `biggest` | Branch |
|---|---|
| `null`, or under `9007199254740991` | **proceed** — declare it as `money()` |
| at or over `9007199254740991` | **⛔ STOP.** Report the table, the column and the value. The remedy is a judgement: the column may store units rather than minor units (fix the writer, then backfill), or the amount may be genuinely that large — then it is `bigint()` or `decimal({ precision, scale })` with the currency in a column of your own. There is no `bigint` money type and there will not be one |

A single over-ceiling row makes every read of that entity throw `X_INVARIANT_VIOLATED` forever. Fix the row before the entity exists.

### 2. Money — currency

**`money()` is an amount *and* a currency by construction.** Per candidate column from check 1, confirm a currency column sits beside it in the same table.

| Table has | Declare as |
|---|---|
| `amount_cents` **+** a `currency` column, no scale column | `money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } })` |
| `amount_cents` + `currency` + a scale column | `money({ columns: { minor, currency, scale } })` — per part, **merged** over the defaults, so a table that renamed one of the three does not restate the other two |
| an amount with **no** currency column | `decimal({ precision, scale })` plus the app's own currency column. **Not `money()`** — a single implied currency is the bug `Money` exists to prevent, and a framework that guessed one would guess on every row |

Detail: [Money](Money).

### 3. Column types

```sql
select data_type, count(*) as columns
from information_schema.columns
where table_schema = 'public'
group by data_type order by columns desc;
```

Match every `data_type` against [the type map](#the-type-map).

| Result | Branch |
|---|---|
| every type has a builder | **proceed** |
| `timestamp without time zone` | plan the conversion to `timestamptz` as a migration step, naming the zone the old values were written in. There is no naive-timestamp builder and there will not be one |
| `USER-DEFINED` that is a native Postgres `enum` type | declare the column as `text()`. It reads and writes correctly; what is missing is a declaration that knows the variants |
| `USER-DEFINED` that is `vector` (pgvector) | **⛔ STOP.** A `vector` column on an entity is not declarable `As of 2026-08`. Report which table |
| `inet`, `cidr`, `tsvector`, `hstore`, `interval`, `citext`, PostGIS | **⛔ STOP.** No builder, none planned. Report the columns; the options are leaving them out of the entity or leaving the table to the legacy app |

### 4. Password hashes

```sql
select left(password_digest, 4) as scheme, count(*)
from users group by scheme order by count desc;
```

| Prefix | Branch |
|---|---|
| `$2a$`, `$2b$`, `$2y$` (bcrypt) | **proceed.** Verified: the hash verifies through `verifyPassword`, `needsRehash` answers `true`, and the first successful login rewrites it as argon2id — no code, no user-visible change |
| `$arg` (argon2) | **proceed.** Rehashed on login when the stored parameters are weaker than the policy |
| anything else — `pbkdf`, `sha`, `md5`, scrypt, bespoke | **⛔ STOP.** No verifier ships. Such a row is safe — it is the one generic credential failure, not a 500 — but it never migrates itself and it burns lockout budget on every attempt ([Passwords](#passwords-rehash-on-login)). Report the schemes and their counts |

### 5. Row counts — the backfill budget

```sql
select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 20;
```

`backfill()` paces at `rate` batches per second of `batch` rows. At the defaults — 1,000 rows, 5 batches/second — 200 million rows is about eleven hours of wall clock. Record the number; it sizes Phase 6.

### 6. Who owns DDL

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('schema_migrations', 'django_migrations', 'knex_migrations',
                     '_prisma_migrations', 'x_migrations')
order by table_name;
```

| Result | Branch |
|---|---|
| only `x_migrations`, or nothing | **proceed** — Ultimate owns DDL |
| a legacy ledger table is present | **⛔ STOP.** Two migration engines against one schema is the failure mode of every shared-database strangler. A human decides which one is frozen, and writes it down |

### 7. Tenancy

```sql
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and column_name in ('org_id', 'tenant_id', 'account_id', 'workspace_id')
order by table_name;
```

Presence of a tenant column is what turns tenancy on. Declare it with `.tenant()` on the column, or `tenant:` on the entity; omitted, it is inferred from `.tenant()` or a property named `orgId`. A tenant-scoped entity refuses any query with no org predicate — so a table listed here and not declared is `X_TENANCY_UNSCOPED` at the first read.

---

## Phase 1 — Model the slice's schema

**Entry:** Phase 0 exits clean.
**Exit:** `x entities --json` → `.ok`, and every table this slice owns appears with every one of its columns.

### 1.1 Declare the entities

One `entity()` per table, in `packages/db/src/`. **Every column of every table the slice owns** — a column left out is drift (Phase 2).

```ts
import {
  arrayOf, bigint, bytes, database, date, decimal,
  entity, json, money, t, text, timestamp, uuid,
} from '@ultimat3/entity';

export const orders = entity('order', {
  table: 'tbl_orders',                              // the physical table
  columns: {
    id:          uuid().primaryKey().column('order_uuid'),
    orgId:       uuid().tenant().column('tenant_id'),
    legacyId:    bigint().unique().column('id'),    // int8 past 2^53 — row type is a string
    reference:   text({ max: 64 }).column('order_ref'),
    total:       money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),
    taxRate:     decimal({ precision: 18, scale: 8 }).column('tax_rate'),
    effectiveOn: date().column('effective_on'),     // a calendar date — PlainDate, no zone
    payload:     json(t.object({ source: t.string, retries: t.number.int() })).column('meta'),
    signature:   bytes().column('sig'),
    tags:        arrayOf(text({ max: 40 })),
    createdAt:   timestamp().defaultNow().column('created'),
  },
});

export const db = database({ orders });

orders.$name;      // 'order'         — the framework's key
orders.$table;     // 'tbl_orders'    — the physical object
orders.$cacheTag;  // 'entity:order'  — keyed by the NAME, so renaming a table moves no tag
```

### 1.2 The three physical-name overrides

| Override | Declares |
|---|---|
| `entity(name, { table })` | the physical table, when it is not the entity's own name. **The entity name stays the framework's key** — the registry, the cache tag, `x entities describe`, every relation and every policy are keyed by it, so renaming a table never moves a cache tag or a policy. Index names follow the **table**, because an index is a physical object |
| `.column('<physical>')` | one column's physical name. Name it **last** in the chain — that link returns the general column, so a builder's own methods (`defaultNow()`, a uuid key's narrowed `primaryKey()`) come first. `uuid()` and `timestamp()` override it to keep theirs |
| `money({ columns: { minor, currency, scale } })` | where the money columns already live, merged **per part** over the `<name>_minor` / `<name>_currency` / `<name>_scale` defaults. `scale: null` says the table has no scale column, which means every amount is at the currency's own minor unit |

Without an override a column is `snake(property)` and the table is the entity name.

### The type map

Two vocabularies. `columns.ts` holds the **opinionated** builders — one way to store an id, an instant, money — each a decision the framework made for a table it was going to create. `columns-data.ts` holds the shapes a table **already has**. Both export from `@ultimat3/entity`.

| Legacy Postgres type | Declare as | Row type | `As of 2026-08` |
|---|---|---|---|
| `uuid` | `uuid()` | `string` | shipped |
| `text`, `varchar(n)` | `text()` / `text({ max: n })` | `string` | shipped. The `CHECK` is `char_length(col) <= n`, not a `varchar` cast |
| `integer`, `serial` | `integer()` | `number` | shipped |
| `boolean` | `boolean()` | `boolean` | shipped |
| `timestamptz` | `timestamp()` | `Date` | shipped |
| `text` with a fixed value set | `enumerated([...])` | the union | shipped — emitted as a `CHECK`, never `CREATE TYPE`, so adding a variant is a one-line migration instead of an `ALTER TYPE` that cannot run inside a transaction on older servers |
| a URL column | `url()` | `string` | shipped, validated on write |
| an IANA zone column | `tz([...])` | the union | shipped |
| a BCP-47 locale column | `locale([...])` | the union | shipped |
| `bigint` + `char(3)` (+ `integer` scale) amount | `money({ columns })` | `MoneyValue` | shipped |
| `jsonb` / `json` | `json(schema)` | the schema's inferred type | shipped. The schema is **required** — there is no untyped `json()`, because a column returning `unknown` is the `any` hole this framework forbids, and the value arrives from the database as often as from a caller |
| `bigint` / `int8` | `bigint()` | **`string`** | shipped. Not a JS `bigint` (`JSON.stringify` throws on one) and not a `number` (it loses digits past 2^53, exactly where a legacy `int8` key or a snowflake id lives). Both driver spellings arrive and leave as one: Bun's `sql` returns `int8` as a string, PGlite as a `bigint` |
| `numeric` / `decimal` | `decimal({ precision, scale })` | **`string`** | shipped, and deliberately not arithmetic-friendly — the honest thing a driver already does is give you the digits. A value with more decimal places than the column stores is **refused, not rounded**. `precision` and `scale` are declared together, or neither |
| `date` | `date()` | `PlainDate` | shipped. A calendar date: no time, therefore no zone. A branded ISO string, not a `Date` — binding a `Date` to a `date` parameter fails outright on a server whose client zone has no name Postgres knows |
| `bytea` | `bytes()` | `Uint8Array` | shipped, normalised — Bun returns a `Buffer`, PGlite a `Uint8Array`, and the two serialise differently |
| an array column | `arrayOf(column)` | `readonly T[]` | shipped. The element is a column, so its own `$parse` decides every member. `arrayOf(money())` and nested arrays are refused **at declaration** |
| `timestamp without time zone` | — | — | **no builder, and there will not be one.** A naive timestamp is a bug that only surfaces twice a year |
| a native Postgres `enum` **type** | `text()` today | `string` | **deferred.** `text()` reads and writes such a column correctly; what is missing is a declaration that knows the type's variants |
| `vector` (pgvector) | — | — | **deferred.** `PgVectorStore` in `@ultimat3/ai` is the retrieval path; a `vector` **column** on an entity is not declarable |
| `inet`, `cidr`, `tsvector`, `hstore`, `interval`, `citext`, PostGIS | — | — | **no builder**, and none planned |

### 1.3 There is no schema-to-entity generator

No command turns a live schema into `entity()` declarations `As of 2026-08`. `introspect()` from `@ultimat3/db` is public and gives the catalog as deterministically ordered, JSON-safe output — the same reader drift detection, the admin schema view and the MCP `schema.describe` tool use:

```ts
import { introspect } from '@ultimat3/db';

const live = await introspect();
// { tables: [{ schema, name, columns, primaryKey, indexes, foreignKeys }] }
```

Use it as the input; write the entities.

---

## Phase 2 — Reach green

**Entry:** Phase 1 exits clean.
**Exit:** `x db migrate --json` → `.ok` **and** `x verify --json` → `.ok`.

```bash
x db gen "adopt <slice>" --json     # entities diffed against what the migrations declare
x db migrate --json                 # apply, then the live post-migrate drift check
x verify --json                     # the gate
```

### What drift compares

`x db migrate`, `x db reset` and `ROLE=migrate` run a post-migrate check of the **live catalog** against what the applied migrations' snapshots declare. It filters out framework bookkeeping — every table whose name starts with `x_` — and nothing else.

| Live | Reported | Meaning |
|---|---|---|
| a table no migration declares | `unexpected-table` | a legacy table not modelled |
| a column on a modelled table that no snapshot names | `unexpected-column` | a column left out of the entity |
| a nullability disagreement | `changed-column` | the entity says `NOT NULL` and the table does not, or the reverse |
| a **type** disagreement | *nothing* | types are deliberately not compared — the catalog and a snapshot spell them differently often enough that comparing them would report drift on a correct database |
| an index no snapshot names | *nothing* | only the declared side is judged. A DBA's index is a planner decision, not a divergence |

`x verify`'s `drift` step is a **different** check: it compares the entity **source** against the hash sidecar committed beside each migration and opens no database. Two conditions, two detectors, one `X_DB_DRIFT`.

### Nothing baselines a pre-existing schema

No command snapshots what is already there as the starting point migrations are measured against. Two paths, pre-decided:

| Path | Take it |
|---|---|
| **Model every table and every column** | by default. It is the only path that ends with `x db migrate` green against the real database |
| **Give Ultimate its own database** | only when modelling the legacy schema is a bigger project than the migration. Drift is clean immediately; cross-database work becomes entirely yours, and `db()` holds one connection ([One database, globally](#one-database-globally)) |

A separate Postgres **schema** is still not a third path `As of 2026-08`, for one reason rather than the two this page carried until now.

**The `search_path` itself now works.** `connectionUrl` **merges** the operator's libpq `options` instead of assigning over them, on every role, so a `DATABASE_URL` carrying `?options=-c search_path=app` survives everywhere. The framework wins only on the setting it names — the role's `statement_timeout` bound — and every other `-c` an operator wrote is theirs.

**The drift check does not follow it.** `introspect()` defaults `schema` to `'public'`, `checkDrift()` forwards a `schema` option only when it is given one, and `runMigrations` calls `checkDrift({ migrations })` with none. So the post-migrate check reads `public` whatever the session's `search_path` is: it finds none of the app's tables, and reports **every declared table as `missing-table`** whose `fix:` is `x db migrate` — the command that just ran. There is no `--schema` flag on `x db` to close it with.

### Branch table

| `.findings[].code` | `meta.kind` | Action |
|---|---|---|
| `X_DB_DRIFT` | `unexpected-table` | add an `entity()` for the table `cause` names, then re-run `x db gen` |
| `X_DB_DRIFT` | `unexpected-column` | add the column to that entity — `.column('<physical>')` when the property name differs — then re-run `x db gen` |
| `X_DB_DRIFT` | `changed-column` | the `fix:` is the exact `alter table … alter column …` to put in a new migration |
| `X_DB_DRIFT` | `unknown-schema` | the newest applied migration wrote no snapshot. The `fix:` names both remedies, in order |
| `X_MIGRATION_SNAPSHOT_MISSING` | — | the same condition from the other side. Take the `fix:` verbatim |
| `X_MIGRATION_DESTRUCTIVE` | — | **⛔ STOP.** A committed `up` drops, truncates or retypes. Do not add `-- destructive: true` and do not pass `--allow-destructive` |
| `X_TENANCY_UNSCOPED` | — | the entity has a tenant column and the query carries no org predicate. Scope the read |
| `X_NOT_IN_APP` | — | no `app.config.ts` at or above the cwd |
| anything else | — | `x errors explain <CODE> --json` → run `.data.fix` → re-run the step |

---

## Phase 3 — Bridge identity

**Entry:** Phase 2 exits clean.
**Exit:** a request carrying a legacy session cookie resolves to an `Actor` with the right `id`, `orgId` and `roles`.

Ultimate re-reads the user row on **every request** and trusts no claim from a token. A revoked user is revoked on the next request, with no stale-claims window — and that is why the bridge is app code rather than a config line.

### Accept the legacy session

`configureAuthenticator()` is the seam. Ultimate ships **no** general-purpose JWT verifier: `verifyIdToken` is OIDC-shaped and wants an issuer, a client id, a nonce and a JWKS key source, which a bespoke app JWT has none of.

```ts
import { userActor } from '@ultimat3/core';
import { configureAuthenticator } from '@ultimat3/http';

/** Your own verifier, over the legacy app's signing key. */
declare function verifyLegacyJwt(token: string): Promise<{
  sub: string;
  org: string;
  roles: readonly string[];
} | null>;

configureAuthenticator(async (request) => {
  const cookie = request.header('cookie') ?? '';
  const token = /(?:^|;\s*)legacy_session=([^;]+)/.exec(cookie)?.[1];
  if (token === undefined) return null;
  const claims = await verifyLegacyJwt(token);
  if (claims === null) return null;
  return userActor({ id: claims.sub, orgId: claims.org, roles: [...claims.roles] });
});
```

| Rule | Detail |
|---|---|
| `null` means anonymous | not an error |
| **One** authenticator per process | two functions answering "who is this?" is two identities per request |
| Call it at module scope under `apps/*/` | a process with routes declaring `auth: 'required'` and no authenticator refuses every session, and `x dev` says so with an `X_CONFIG_INVALID` line naming the fix |

### Passwords: rehash on login

`verifyPassword` calls `Bun.password.verify`, which reads the algorithm out of the PHC string.

| Stored hash | Behaviour |
|---|---|
| `$argon2id$…` at weaker parameters than the policy | verifies; `needsRehash` is `true`; `login()` rewrites it at the current parameters while it still holds the plaintext |
| `$2a$` / `$2b$` / `$2y$` **bcrypt** | verifies; `needsRehash` is `true` (the PHC prefix is unrecognised, which the rule treats as "upgrade it"); rewritten as argon2id on that first successful login |
| PBKDF2, scrypt, SHA-family, MD5, bespoke, or a truncated hash | **does not verify** — it is the one generic credential failure, indistinguishable from a wrong password. Not a migration path: nothing rewrites the row |

**An unreadable hash is safe, and it is silent — both matter here.** `Bun.password.verify` *throws* on a hash it cannot parse (measured on bun 1.3.14: a Django `pbkdf2_sha256$…` row is `UnsupportedAlgorithm`, a truncated bcrypt string is `InvalidEncoding`). `verifyPassword` catches that and routes it through the **same** branch as an unknown user — burning the same full KDF, so neither the answer nor the response time separates it from a wrong password ([`packages/auth/src/password.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/password.ts)). `X_OVERLOADED` from the KDF gate is re-thrown rather than swallowed: load shedding is not a verdict on the credential.

Three consequences you plan around:

| Consequence | What it means during a migration |
|---|---|
| **It consumes lockout budget** | a failed verification is a failed verification: `recordFailure` fires on the account, the IP and the org bucket alike ([`packages/auth/src/auth.ts:246`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/auth.ts)). A table full of foreign hashes locks accounts out through ordinary login attempts, at the normal rate |
| **Nothing is logged**, deliberately | the algorithm of an unreadable hash is the same oracle one layer down, and a line per attempt is a spray amplifier. So you see uniform credential failures and no signal that the cause is the hash scheme rather than the password |
| **It is not a migration path** | nothing rewrites the row. bcrypt is the only "proceed" case — verified natively, `needsRehash` flags it, and the first successful login rewrites it as argon2id |

So a non-bcrypt estate still needs a plan before Phase 3: bridge the legacy login endpoint and keep it until the last user has signed in, or force a reset for the remainder.

### Enterprise SSO

OAuth2/OIDC with PKCE, nonce and JWKS signature verification ships, and the provider set is **open** — `registerOAuthProvider()`, or `discoverOAuthProvider({ id, issuer })` to read one out of the issuer's discovery document. Okta, Entra, Ping, Keycloak and an internal gateway are all expressible.

**SAML does not ship and will not.** XML-DSig canonicalisation has no Bun native, and implementing it would put a real dependency in the primitive vocabulary. Put an OIDC-speaking SAML bridge in front and register **that**.

---

## Phase 4 — Reads through Ultimate

**Entry:** Phase 3 exits clean.
**Exit:** `x queries --json` lists the slice's reads, `x verify --json` → `.ok`, and the slice's read paths answer from Ultimate for a full traffic cycle with error rate and p95 unchanged.

| Step | Postcondition |
|---|---|
| declare the slice's `query()`s and `policy`s | `x queries --json` → `.ok`, listing them |
| write the contract tests | `x verify --json` → the `.steps[]` entry named `contract` has `ok: true` |
| route the slice's read paths at the proxy | **⛔ STOP** when this is production traffic |

Reads move **before** writes, and that ordering is what makes Phase 4 rollback-safe: routing the paths back at the proxy is a complete undo, because nothing was written.

### What Ultimate does not see

| Concern | Consequence while both apps run |
|---|---|
| Caching | Ultimate's tags are its own. A legacy write it does not know about goes stale until its TTL → [Caching and invalidation](Caching-And-Invalidation) |
| Realtime | live queries observe Ultimate's own layer. A row the legacy app writes pushes no patch |
| Background jobs | Ultimate's queue is `x_jobs` plus a transactional outbox. It does not read the legacy queue and cannot |

Which is why the unit of migration is a **slice**: move a table's reads and writes together, or accept staleness on the half you did not move.

### One thing a renamed column does not survive: a live query

`As of 2026-08` a **live query** delivers a renamed column under its **physical** name. `@ultimat3/realtime` rebuilds an entity row from the replication stream's physical column names alone — `camel()` in [`packages/realtime/src/pg-entity-row.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/pg-entity-row.ts) — and never consults `.column()` overrides, because that package is tier 3 and declares no dependency on `@ultimat3/entity` at tier 2.

| Read through | `githubLogin: text().column('gh_login')` arrives as |
|---|---|
| a repository / `query()` | `githubLogin` |
| a **live** query patch | `ghLogin` |

Real, unfixed, and a design call rather than an oversight: the alternative is a tier violation or a second copy of the naming rule. **Action:** do not make a slice with renamed columns your first live slice, or have the subscriber map the physical name itself.

---

## Phase 5 — Writes through Ultimate

**Entry:** Phase 4 exits clean and has held for a full traffic cycle.
**Exit:** the legacy write path for this slice is dead code, not a fallback.

| Step | Postcondition |
|---|---|
| declare the slice's `action()`s and `mutator()`s | `x actions --json` → `.ok`, listing them |
| `x verify --json` | `.ok` |
| route the slice's write paths | **⛔ STOP** when this is production traffic |

**Expand before you contract.** New columns nullable, the old column still written for one release, no drops. That is what keeps the Phase 4 rollback available after writes move: routing back only works if Ultimate wrote nothing the legacy app cannot read.

---

## Phase 6 — Reshape the data

**Entry:** Phase 5 exits clean.
**Exit:** `x db backfill --pending --json` → `.ok` (it exits non-zero while anything declared is unswept).

`backfill()` is a factory over `job()` — a one-pass sweep declared as durable background work. It resumes, it paces, and it refuses to run in an environment it was not declared for.

```ts
import { backfill } from '@ultimat3/jobs';
import { db, referenceFor } from './schema';

export const normaliseOrderRefs = backfill({
  name: 'normalise-order-refs',
  tenant: 'none',
  requires: '20260814120000_add_order_ref',        // the migration this sweep needs applied first
  environments: ['staging', 'production'],
  batch: 1_000,
  rate: 2,                                        // batches per second
  source: () => db.orders.where({ reference: null }),
  count: () => db.orders.where({ reference: null }).count(),
  handle: async ({ rows }) => {
    // Idempotent: the second run writes the same value, so a replayed page changes nothing.
    await db.orders.upsertAll(
      rows.map((row) => ({ ...row, reference: referenceFor(row.id) })),
      { onConflict: ['id'], onMatch: 'update' },
    );
  },
});
```

```bash
x db backfill <name> --json            # dry run — reports the plan, writes nothing
x db backfill <name> --write --json    # enqueue the pass
x db backfill --list --json            # the x_backfills ledger
x db backfill --pending --json         # declared minus completed; non-zero exit when unswept
```

| Property | Why it matters here |
|---|---|
| Every page is its own `step.run` | a killed attempt resumes on the page it stopped at. What a step persists is a **cursor**, never the page |
| `handle` is **at least once** | it runs before its checkpoint lands, so an attempt cancelled between the two replays that page. Write with `upsertAll`, `updateWhere`, or a statement whose second run changes nothing — **never `count + 1`** |
| Pacing is mandatory | `rate` defaults to 5 batches/second and there is **no unthrottled mode**: this pass shares its pool with the requests the app is still serving |
| `environments` is a gate | a mismatch is `X_BACKFILL_ENVIRONMENT`, refused inside the pass as well as by the CLI, because a backfill enqueued by app code never passes through a command |
| `requires` names a migration | checked against `x_migrations`, so a sweep cannot run against a schema that has not caught up |
| `count` makes convergence arithmetic | a pass whose source is exhausted while `count` still answers above zero has two predicates that disagree — `X_BACKFILL_STALLED`, an authoring bug |
| The ledger is append-only | a rerun is a **new** row; history is never overwritten. The idempotency key is the name, so a second enqueue while it runs is the same pass |

| `.findings[].code` | Action |
|---|---|
| `X_BACKFILL_ENVIRONMENT` | the sweep is not declared for this environment. Add it to `environments:`, or run it where it is declared |
| `X_BACKFILL_STALLED` | `source` and `count` disagree. Fix the predicate; do not re-run |
| `X_ABORTED` | the attempt was cancelled. Re-enqueue the same name — it resumes at the last checkpoint |

For **reference data** the new app is wrong without — currencies, plans, tiers, locations — use `x db seed` instead. A seed is replayable by construction and declares a tier: `reference` ships to production, `dev` does not reach it without `--tier dev`.

```bash
x db seed --dry-run --json            # lists every declared seed, writes nothing
x db seed <name> --json
```

Full detail: [Migrations and backfills](Migrations-And-Backfills).

---

## Phase 7 — Retire the legacy slice

**⛔ STOP. Every step of this phase is a human's.**

| Step | Why it is a stop |
|---|---|
| Delete the legacy slice's source | the rollback path dies with it |
| Drop the legacy columns or tables | irreversible. `x db gen` refuses without `--allow-destructive`, and that refusal is the guard |
| Delete migrated source data | irreversible at any scale |
| Retire the legacy login endpoint | strands every user still holding a legacy cookie |

Report to the human: which slices are complete, `x verify --json`'s result, `x db backfill --pending --json`'s result, and the exact tables and columns that would be dropped.

---

## Reference

### Cutover topologies

| Topology | Supported `As of 2026-08` |
|---|---|
| **Strangler fig, one shared database** | **the supported path.** Everything above assumes it |
| **Strangler fig, two databases** | **partially.** `db()` is one global handle, so Ultimate holds exactly one of the two. The reconciliation is entirely yours |
| **Read replica first** | **no.** No read/write split exists at any layer; pointing `DATABASE_URL` at a replica fails every write, the migration ledger's included |
| **Big bang** | technically possible, and the one that fails. Not documented here |

### One database, globally

`db()` is a module-level singleton in [`packages/db/src/client.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/client.ts): one ambient client, built lazily from `DATABASE_URL`, sized by the runtime `ROLE`. `setDbClient()` replaces it and does not add a second.

| Consequence | Detail |
|---|---|
| Ultimate holds exactly **one** database | a second is reachable only through your own client — outside `db()`, outside transactions, outside the observer seam, outside N+1 detection |
| Inside `withTransaction`, `db()` **is** the transaction | which is what lets a repository written against `db()` join the caller's transaction without knowing it exists |
| The pool is sized per role | `web: 20`, `sync: 10`, `worker: 8`, `scheduler: 2`, `migrate: 1`, `replicator: 4`. `DATABASE_POOL_MAX` is the one knob an operator turns without a rebuild — 400 `web` pods at 20 is 8,000 backends against a `max_connections` of 450 |

### What does not work yet

Verified against the code, `As of 2026-08`.

| Gap | Detail | Do this instead |
|---|---|---|
| No schema baseline | every unmodelled table is `unexpected-table`, every unmodelled column is `unexpected-column`; no command snapshots the pre-existing schema as a starting point | model everything, or give Ultimate its own database |
| No schema-to-entity generator | no command turns a live schema into `entity()` declarations. `introspect()` is public and gives the catalog as JSON | write the entities from `introspect()`'s output |
| Three column shapes have no builder | a naive `timestamp without time zone` (permanently), a native Postgres `enum` **type**, and `vector` | convert a naive timestamp to `timestamptz`; declare an enum column as `text()`; keep vectors in `PgVectorStore` |
| A renamed column arrives under its **physical** name in a live query | `@ultimat3/realtime` rebuilds rows from physical names and cannot read `.column()` overrides across the tier boundary | do not make a renamed slice live first, or map the name in the subscriber |
| One database globally | `db()` is a singleton | one Postgres, or a second client outside the framework |
| No read/write split | at any layer | a replica cannot serve Ultimate |
| No legacy-hash verifier beyond bcrypt/argon2 | an unreadable hash is the generic credential failure — safe, silent, and it consumes lockout budget — but nothing rewrites the row | bridge the legacy login, or force a reset |
| No SAML | permanently out of scope | an OIDC bridge in front |
| No app-contributed raw `Route` | the HTTP surface is composed from actions, queries, assets and page routes; `configureAuthenticator()` is the only app-installed hook of that shape | express the endpoint as an `action` or a `route` |
| Cache and realtime do not see legacy writes | Ultimate's tags and live queries observe its own layer | move a slice's reads and writes together |

### Rollback

Available at every phase up to 7, by routing the slice's paths back to the legacy app at the proxy.

| Risk | Mitigation |
|---|---|
| A migration dropped or retyped a column | `x db gen` needs `--allow-destructive` to emit one, and a committed `up` that destroys must carry `-- destructive: true` or the gate refuses it. Take the refusal as the answer |
| Ultimate wrote a column the legacy app cannot parse | add columns nullable, expand before you contract, keep the old column written for one release |
| A backfill half-ran | it resumes; it does not restart. Re-enqueue the same name |
| Sessions were reissued as Ultimate sessions | keep the legacy cookie valid until the slice is permanent |

## Rules

- Strangler fig on one shared database. Move a slice's reads and writes together.
- Every step has a machine-checkable postcondition: `--json`, then `.ok`; on failure, `.findings[].code`.
- Branch on error codes by name. An unrecognised one is `x errors explain <CODE> --json`, then `.data.fix`.
- One owner for DDL, decided by a human before Phase 1.
- Audit money before writing an entity: `select max(abs(<col>))` against 9,007,199,254,740,991, and confirm a currency column beside every amount.
- An amount with no currency column is `decimal()` plus your own column, never `money()`.
- Declare every table and every column, or drift is red on every `x db migrate`.
- Physical names are overrides: `entity(name, { table })`, `.column('<physical>')`, `money({ columns })`. The entity **name** stays the framework's key.
- A live query delivers a renamed column under its physical name.
- Bcrypt migrates itself on first login. Nothing else does — a foreign hash fails safely, silently, and forever.
- Reshape with `backfill()`: paced, resumable, at least once, so every `handle` must be idempotent.
- Reads move before writes, so rollback stays a proxy change.
- Anything irreversible or outward-facing is a ⛔ STOP. Halt and report.
