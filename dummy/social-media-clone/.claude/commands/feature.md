---
description: Ship one feature end to end — understand, build primitive-first, gate, PR.
---

Ship the feature described in `$ARGUMENTS`.

1. **Understand.** Ask CodeGraph, not grep, for structure. Read `AGENTS.md` and the feature's
   existing `apps/web/app/<feature>/` if it has one.
2. **Distrust the paperwork.** Check any plan or doc against the code and `git log` before planning
   off it. Say plainly which claims you falsified.
3. **Pick the primitive.** Everything is one of: `entity` `policy` `action` `mutator` `query` `job`
   `route` `task`. If it fits none, the design is wrong — do not invent a ninth. A new capability
   arrives as a factory over an existing primitive.
4. **Scaffold, do not hand-write:** `x g resource|action|mutator|query|job|route|policy|entity|task`.
5. **Build.** Server-authoritative and online-only → `action`. Must work offline → `mutator` with
   `local`/`server`/`conflict`. Reads that must stay fresh → `query({ live: true })`, ordered and
   bounded. Work outliving the request → `job` with a required `idempotencyKey`. Scheduled → `task`
   with an explicit IANA `tz`; a task only enqueues.
6. **Ship the guard with the fix.** A rule that is not a build error does not exist. Climb as high as
   you can afford: type → assertion → contract test → `scripts/lint/<rule>.ts`.
7. **Gate:** `bin/check`. Green means shippable. Never merge red.
8. **PR.** One slice, one PR. Include the `## Live test` block with the commands that prove it.

Stop and report if the work needs a file another agent holds, or if the right fix is outside the
slice. Never edit across the line.
