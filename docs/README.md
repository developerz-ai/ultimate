# 📚 Ultimate — documentation map

Two bodies of docs, one split:

| Where | Answers | Read it when |
|---|---|---|
| [**idea/**](idea/README.md) | **what and why** | you want to understand a decision, or argue with it |
| [**architecture/**](architecture/README.md) | **how it's built** | you're changing the framework itself |
| [**ops/**](ops/README.md) | **how to run it** | you're deploying an app, or something is on fire |

Plus, outside `docs/`:

| Where | What |
|---|---|
| [`../wiki/Home.md`](../wiki/Home.md) | the reference manual — every field, flag, and error code |
| [`../llms.txt`](../llms.txt) | the machine-readable repo map — start here if you're an agent |
| [`../examples/dummy/`](../examples/dummy/README.md) | the reference app: every primitive, once, idiomatically |
| [`../CLAUDE.md`](../CLAUDE.md) | the project brain — commands, tiers, non-negotiables |

## 🧭 Reading order

**New to Ultimate:**

1. [idea/00-thesis.md](idea/00-thesis.md) — why the framework exists and who it's for
2. [idea/02-primitives.md](idea/02-primitives.md) — the eight primitives
3. [idea/13-dx.md](idea/13-dx.md) — what using it feels like
4. [../examples/dummy/README.md](../examples/dummy/README.md) — the same ideas as working code

**Changing the framework:**

1. [architecture/00-conventions.md](architecture/00-conventions.md) — the coding contract
2. [architecture/01-package-map.md](architecture/01-package-map.md) — what owns what
3. [architecture/02-boundaries.md](architecture/02-boundaries.md) — the tier rules that fail your build
4. [architecture/15-adding-a-feature.md](architecture/15-adding-a-feature.md) — the checklist

**Deciding whether to bet on it:**

1. [idea/14-roadmap.md](idea/14-roadmap.md) — the twelve milestones
2. [idea/15-risks.md](idea/15-risks.md) — what could sink it, stated plainly

**Running it in production:**

1. [ops/README.md](ops/README.md) — the ladder, and the signal that says climb
2. [ops/03-observability.md](ops/03-observability.md) — what to scrape, what to alert on
3. [ops/06-runbooks.md](ops/06-runbooks.md) — read before the incident, not during

## 📖 Doc conventions

This repo dogfoods its own writing rules:

- Lead with the rule, not the reason. Fragments over sentences.
- Tables for any ≥3-row structure.
- Code blocks, paths, and commands verbatim — compress the prose around them, never them.
- No meta-framing, no rhetoric, no trailing summary paragraph.
- One topic per file, scannable in one pass.
- Date load-bearing claims (`As of 2026-07`). Delete a stale doc rather than let it rot — a wrong doc costs more than a missing one.
- Cross-link with relative paths.
