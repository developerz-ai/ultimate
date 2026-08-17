-- 0002_money_scale
-- HAND-WRITTEN, and it has to be: `x db gen "money scale"` answers X_MIGRATION_SNAPSHOT_MISSING
-- in this app — 0001_init records no `.snapshot.json`, so the generator has nothing to diff
-- against and refuses rather than emitting `create table` for everything that already exists.
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
-- No `.hash` sidecar on purpose. The sidecar records a hash of the WHOLE schema source, and this
-- app's `drift` step is pinned red (scripts/lib/gated-apps.ts) because 0001's recorded hash
-- already predates that source. One column does not earn the claim that the migrations describe
-- it, and a hash written here would make the pin go green without regenerating anything.

alter table "plans" add column "monthly_scale" integer check (monthly_scale is null or (monthly_scale >= 0 and monthly_scale <= 15));

-- down
alter table "plans" drop column "monthly_scale";
