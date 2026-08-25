-- 0002_money_scale
-- HAND-WRITTEN, as 0001 was: both predate `x db gen` in this app.
-- The statement below is byte-for-byte what `generateMigration`'s `diffTable`/`columnClause`
-- emits for this column, and the CHECK is `@ultimat3/entity`'s own `scaleCheck` — so a psql
-- session cannot write a scale the app would refuse to read back.
-- Editing an applied migration changes its checksum: X_MIGRATION_CONFLICT on the next apply.
--
-- `plans.monthly` is this app's only `money()` column, and money is three physical columns since
-- `MoneyValue.scale` began to persist: without `monthly_scale` every read of this table names a
-- column it does not have. NULL is the right value for every existing row — it means "the
-- currency's own minor unit", which is what those rows always meant. `0` would mean whole units.
--
-- The `.snapshot.json` beside this file is hand-written too, 2026-08-25, and it is what unblocked
-- the generator: `x db gen` diffs the entities against the NEWEST migration's sidecar, and with
-- none it answered X_MIGRATION_SNAPSHOT_MISSING and refused rather than emitting `create table`
-- for six tables that already exist. Its own `fix:` is not available here — deleting this
-- migration only moves the refusal to 0001, and deleting that one too is the squash, which was
-- measured on 2026-08-25 and LOSES 10 invariants, 9 defaults and both REPLICA IDENTITY FULL with
-- `drift` green over it (scripts/lib/gated-apps.ts records the measurement).
--
-- What the sidecar records is what THIS SQL creates — `varchar(80)` where the entity declares
-- `text`, `post_slug_unique_per_org` where it declares `post_slug_unique`, and the enum types —
-- never what the entities declare. That is the whole point: recording the declaration would be
-- the same lie the squash tells, and the 53 differences `x verify`'s `drift` step now itemises
-- are all real. Three limits of the vocabulary, so a reader does not mistake them for errors:
-- `SchemaDescription` has no field for a CREATE TYPE, none for a column-level CHECK (so 0002's
-- own `monthly_scale` check is absent, as it would be in a generated sidecar — `snapshotOf`
-- records `declaredChecks` only), and one `order` per index rather than one per column, so
-- `posts_feed_idx` reads `desc` for the pair rather than for `published_at` alone.
--
-- No `.hash` sidecar on purpose. The sidecar records a hash of the WHOLE schema source, and this
-- app's `drift` step is pinned red (scripts/lib/gated-apps.ts) because 0001's recorded hash
-- already predates that source. One column does not earn the claim that the migrations describe
-- it, and a hash written here would make the pin go green without regenerating anything.

alter table "plans" add column "monthly_scale" integer check (monthly_scale is null or (monthly_scale >= 0 and monthly_scale <= 15));

-- down
alter table "plans" drop column "monthly_scale";
