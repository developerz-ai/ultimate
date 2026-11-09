**Status: `not executed end to end`.** No Rails app has been cut over by following this page yet; it flips to `executed` on evidence from an adopter's measured run.

# Migrating from Rails

The concept map for a Rails app. The runbook — phases, exit conditions, stop conditions — is
[Migrating an existing app](Migrating-An-Existing-App); this page says what each Rails term
becomes. `As of 2026-11`, against Rails 8 ([guides.rubyonrails.org](https://guides.rubyonrails.org/)).

## Concept map

| Rails | Ultimate |
|---|---|
| `config/routes.rb` + a controller action that renders | a route file: [Routes and render modes](Routes-And-Render-Modes) |
| a controller action that writes | an `action`: [Actions](Actions) |
| an Active Record model | an `entity()`: [Entities and migrations](Entities-And-Migrations) |
| a scope, a `where` chain | a `query`: [Queries and live queries](Queries-And-Live-Queries) |
| `db/migrate/*.rb`, `schema.rb` | `x db gen "<name>"`, then `x db migrate` |
| `rails generate` | `x g <kind> <name>` ([CLI reference](CLI-Reference)) |
| Active Job, Sidekiq | a `job`: [Jobs and workflows](Jobs-And-Workflows) |
| `whenever`, `sidekiq-cron` | a `task`: [Scheduled tasks](Scheduled-Tasks) |
| Devise, `has_secure_password` | [Auth](Auth) |
| Pundit, CanCanCan | a `policy`: [Policies and authz](Policies-And-Authz) |
| Action Cable, Turbo Streams | a live query: [Realtime](Realtime) |
| Action Mailer | [Mail](Mail) |
| Active Storage | [Storage and uploads](Storage-And-Uploads) |
| ActiveAdmin, Administrate | [Admin dashboard](Admin-Dashboard) |
| `config/locales/*.yml` | one flat catalog per locale: [I18n](I18n) |
| RSpec, Minitest | [Testing](Testing) |
| `bin/rails server` | `x dev` |
| `bin/rails test` + CI | `x verify` |

## What does not map

| Rails | Why |
|---|---|
| Ruby and its gems | Bun only. Nothing runs Ruby; a gem's behaviour is rewritten or bought as a service |
| MySQL, SQLite | Postgres only, by design: [Home](Home) |
| ERB, Hotwire, Stimulus | pages render with SolidJS; interactive parts are islands ([Routes and render modes](Routes-And-Render-Modes)). No converter |
| model callbacks (`before_save`, `after_commit`) | no implicit hooks: the write is an `action` or a `mutator` that says what it does ([Actions](Actions)) |
| SAML (`devise_saml_authenticatable`) | not shipped: put an OIDC bridge in front ([Auth](Auth)) |

## Schema adoption

Rails ids are `bigint` sequences and timestamps are `created_at` / `updated_at`. Phase 1 of the
runbook declares the existing tables as entities with the physical-name overrides and type map it
gives, then `x db gen` until `x verify --only drift` agrees: [Migrating an existing app](Migrating-An-Existing-App).

## Identity cutover

| Rails stores | Branch |
|---|---|
| `password_digest` (`has_secure_password`) or Devise's `encrypted_password` — bcrypt by default | **proceed**: verified natively, rewritten as argon2id on first login ([Migrating an existing app](Migrating-An-Existing-App)) |
| the session: an encrypted cookie keyed by `secret_key_base` | bridge it with your own verifier behind `configureAuthenticator()`, or keep the Rails login until every user has signed in once ([Auth](Auth)) |
