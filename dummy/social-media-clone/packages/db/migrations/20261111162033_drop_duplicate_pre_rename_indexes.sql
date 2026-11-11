-- 20261111162033_drop_duplicate_pre_rename_indexes
-- HAND-WRITTEN: `x db gen` has nothing to diff. 20260824215827 created each index below under its
-- hashed name and recorded the old `*_idx` as gone without dropping it, so every snapshot since
-- agrees with the entities while production holds both copies and every write maintains two.
-- The schema dump showed seven identical pairs; this drops the old name of each, concurrently.

-- transaction: false
drop index concurrently if exists "likes_user_id_created_at_idx";
drop index concurrently if exists "media_created_at_idx";
drop index concurrently if exists "messages_conversation_id_created_at_id_idx";
drop index concurrently if exists "notifications_user_id_created_at_idx";
drop index concurrently if exists "posts_author_id_published_at_idx";
drop index concurrently if exists "posts_published_at_idx";
drop index concurrently if exists "users_created_at_idx";

-- down
create index concurrently if not exists "users_created_at_idx" on "users" ("created_at" desc);
create index concurrently if not exists "posts_published_at_idx" on "posts" ("published_at" desc) where (audience = 'public');
create index concurrently if not exists "posts_author_id_published_at_idx" on "posts" ("author_id" desc, "published_at" desc);
create index concurrently if not exists "notifications_user_id_created_at_idx" on "notifications" ("user_id" desc, "created_at" desc);
create index concurrently if not exists "messages_conversation_id_created_at_id_idx" on "messages" ("conversation_id" desc, "created_at" desc, "id" desc);
create index concurrently if not exists "media_created_at_idx" on "media" ("created_at") where (state = 'pending');
create index concurrently if not exists "likes_user_id_created_at_idx" on "likes" ("user_id" desc, "created_at" desc);
