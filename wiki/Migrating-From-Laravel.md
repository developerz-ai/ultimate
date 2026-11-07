**Status: `not executed end to end`.** No Laravel app has been cut over by following this page yet; it flips to `executed` on evidence from an adopter's measured run.

# Migrating from Laravel

The concept map for a Laravel app. The runbook — phases, exit conditions, stop conditions — is
[Migrating an existing app](Migrating-An-Existing-App); this page says what each Laravel term
becomes. `As of 2026-11`, against the current release ([laravel.com/docs](https://laravel.com/docs)).

## Concept map

| Laravel | Ultimate |
|---|---|
| `routes/web.php` + a controller that returns a view | a route file: [Routes and render modes](Routes-And-Render-Modes) |
| a controller that writes, a form request | an `action`, its input schema: [Actions](Actions) |
| an Eloquent model | an `entity()`: [Entities and migrations](Entities-And-Migrations) |
| a query scope, the query builder | a `query`: [Queries and live queries](Queries-And-Live-Queries) |
| `php artisan make:migration`, `migrate` | `x db gen "<name>"`, then `x db migrate` |
| `php artisan make:*` | `x g <kind> <name>` ([CLI reference](CLI-Reference)) |
| a queued job | a `job`: [Jobs and workflows](Jobs-And-Workflows) |
| the scheduler (`schedule:run`) | a `task`: [Scheduled tasks](Scheduled-Tasks) |
| Breeze, Fortify, Sanctum | [Auth](Auth) |
| gates and policies | a `policy`: [Policies and authz](Policies-And-Authz) |
| broadcasting (Reverb, Pusher) | a live query: [Realtime](Realtime) |
| Mailables | [Mail](Mail) |
| `Storage` disks | [Storage and uploads](Storage-And-Uploads) |
| Nova, Filament | [Admin dashboard](Admin-Dashboard) |
| `lang/*.php` | one flat catalog per locale: [I18n](I18n) |
| Pest, PHPUnit | [Testing](Testing) |
| `php artisan serve` | `x dev` |

## What does not map

| Laravel | Why |
|---|---|
| PHP and its packages | Bun only. A Composer package is rewritten or bought as a service |
| MySQL, SQLite, SQL Server | Postgres only, by design: [Home](Home) |
| Blade, Livewire | pages render with SolidJS; interactive parts are islands. No converter |
| model events and observers | no implicit hooks: the write is an `action` or a `mutator` that says what it does ([Actions](Actions)) |
| polymorphic relations (`morphTo`) | model each target as its own foreign key ([Entities and migrations](Entities-And-Migrations)) |

## Schema adoption

Laravel ids are `bigint` (`$table->id()`) and timestamps are `created_at` / `updated_at`. Phase 1
of the runbook declares the existing tables with the physical-name overrides it gives, then
`x db gen` until `x verify --only drift` agrees: [Migrating an existing app](Migrating-An-Existing-App).

## Identity cutover

| Laravel stores | Branch |
|---|---|
| `users.password` as `$2y$…` — bcrypt, Laravel's default driver | **proceed**: verified natively, rewritten as argon2id on first login ([Migrating an existing app](Migrating-An-Existing-App)) |
| `$argon2id$…` (the `argon2id` driver) | **proceed**: rehashed when weaker than the policy |
| the session: an encrypted cookie keyed by `APP_KEY` | bridge it with your own verifier behind `configureAuthenticator()`, or keep the Laravel login until every user has signed in once ([Auth](Auth)) |
