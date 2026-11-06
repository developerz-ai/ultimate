**Status: `not executed end to end`.** No Django app has been cut over by following this page yet; it flips to `executed` on evidence from an adopter's measured run.

# Migrating from Django

The concept map for a Django app. The runbook — phases, exit conditions, stop conditions — is
[Migrating an existing app](Migrating-An-Existing-App); this page says what each Django term
becomes. `As of 2026-11`, against Django 6 ([docs.djangoproject.com](https://docs.djangoproject.com/)).

## Concept map

| Django | Ultimate |
|---|---|
| `urls.py` + a view that renders a template | a route file: [Routes and render modes](Routes-And-Render-Modes) |
| a view that writes, a DRF viewset | an `action`: [Actions](Actions) |
| a model | an `entity()`: [Entities and migrations](Entities-And-Migrations) |
| a queryset, a manager method | a `query`: [Queries and live queries](Queries-And-Live-Queries) |
| `makemigrations`, `migrate` | `x db gen "<name>"`, then `x db migrate` |
| `startapp` | `x g resource <name>` ([CLI reference](CLI-Reference)) |
| Celery tasks | a `job`: [Jobs and workflows](Jobs-And-Workflows) |
| Celery beat | a `task`: [Scheduled tasks](Scheduled-Tasks) |
| `django.contrib.auth` | [Auth](Auth) |
| permissions, `django-guardian` | a `policy`: [Policies and authz](Policies-And-Authz) |
| Channels | a live query: [Realtime](Realtime) |
| `send_mail` | [Mail](Mail) |
| `FileField`, `django-storages` | [Storage and uploads](Storage-And-Uploads) |
| `django.contrib.admin` | [Admin dashboard](Admin-Dashboard) |
| `gettext` `.po` files | one flat catalog per locale: [I18n](I18n) |
| DRF's schema, drf-spectacular | `openapi.json`, projected from every action: [Actions](Actions) |
| `pytest-django`, `TestCase` | [Testing](Testing) |
| `runserver` | `x dev` |

## What does not map

| Django | Why |
|---|---|
| Python and its packages | Bun only. A Python dependency is rewritten or bought as a service |
| MySQL, SQLite, Oracle | Postgres only, by design: [Home](Home) |
| templates | pages render with SolidJS; interactive parts are islands. No converter |
| signals (`post_save`) | no implicit hooks: the write is an `action` or a `mutator` that says what it does ([Actions](Actions)) |
| generic relations (`ContentType`) | model each target as its own foreign key ([Entities and migrations](Entities-And-Migrations)) |

## Schema adoption

Django names tables `<app>_<model>` and ids are `bigint` (`DEFAULT_AUTO_FIELD`). Phase 1 of the
runbook declares the existing tables with the physical-name overrides it gives, then `x db gen`
until `x verify --only drift` agrees: [Migrating an existing app](Migrating-An-Existing-App).

## Identity cutover

| Django stores | Branch |
|---|---|
| `auth_user.password` as `pbkdf2_sha256$…` — Django's default hasher | **⛔ stop**: no PBKDF2 verifier ships, and a row in that scheme never verifies. Keep Django's login as a bridge until every user has signed in once, or force a reset ([Migrating an existing app](Migrating-An-Existing-App)) |
| `bcrypt_sha256$…` | **⛔ stop** for the same reason: the prefix is Django's, not a PHC string |
| the session: `django_session` rows keyed by a cookie | bridge it with your own lookup behind `configureAuthenticator()` ([Auth](Auth)) |
