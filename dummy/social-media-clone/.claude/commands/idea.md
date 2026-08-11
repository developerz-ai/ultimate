---
description: Interview me about what to build — from a prompt, a spec file, or a legacy app to port — then write the spec and scaffold the first slice.
argument-hint: [what you want to build | path/URL to a spec .md | path to a legacy app]
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch, Task
---

Turn an idea into a spec and one working slice. Run `/setup` first — do not do this against a
broken environment.

## 1. Take the seed

$ARGUMENTS

Read it as one of four things, and tell me which you decided:

| Seed | Do this first |
|---|---|
| **nothing** | go straight to the questions |
| **a description** ("a marketplace for vintage guitars") | treat it as the answer to question 1 **only**. It is a seed, not a spec |
| **a path or URL to a `.md`** | read it in full, then list what it already answers and what it leaves open. Do not re-ask what it answered |
| **a path to an existing app** (any stack, any language) | explore it read-only. Report what it does, its data model, its endpoints, and — concretely — **how many files one representative feature costs there**. Then ask what to port and what to leave behind |

**Porting is a translation, never a transcription.** A repository + DTO + mapper + service-interface
+ wiring-adapter + controller becomes **one `action`**. If you find yourself recreating the old
layering, stop: that layering is the thing being escaped. Say what you are deliberately dropping.

## 2. Keep asking until you can name every primitive

Do not stop after one round. A few questions at a time, in plain language — assume I might not be a
developer — and follow up when an answer is vague. "A social app" is not an answer; "people post
short text updates and their friends can like and comment" is.

- Who opens this, and what do they do first?
- Walk me through the single most important flow, start to finish.
- What are the main *things* in it? (posts, invoices, bookings, students…) → `entity`
- Who may do what, to whose rows? Is there more than one kind of user? → `policy`
- Does anything need to work with no internet? → `mutator`, not `action`
- Does anything need to update live, without a refresh? → `query({ live: true })`
- Does anything keep going after the user closes the tab? → `job`
- Does anything happen on a schedule, and in whose timezone? → `task`
- Does anyone upload files? Images, video, documents?
- What is explicitly **not** in version one?

You are done asking when every row of the primitive table has a name. Not before. If something I
want fits none of the eight, tell me — that is a design conversation, not something to route around.

## 3. Write it down

`docs/specs/<NN>-<slug>.md`: problem, users, the happy-path flow, a table of primitive → name →
one-line job, out of scope, and the questions I still owe you. Compact English, fragments over
sentences, tables for anything with three or more rows.

## 4. Configure yourself for this project

The `.claude/` directory that shipped with the scaffold is a **base**, written before anyone knew
what this app is. Now you know. Adapt it — this is the step people skip, and it is the one that
makes every later session cheaper.

| File | What to change now that the domain is known |
|---|---|
| `CLAUDE.md` | fill in the project section with the conventions I just told you that a newcomer **could not guess**. Do not restate the framework rules already there |
| `CLAUDE.md` preventive rules | add one per trap this domain has. The test for inclusion: *would an agent write this bug without the rule?* Write it as **mechanism + cost**, and name the guard that enforces it |
| `.claude/agents/*.md` | rename and re-scope the roles to this app's actual areas. One role per path, so two agents never write the same file — the file set **is** the lock. Delete a role this app has no use for |
| `.claude/skills/` | add a skill for any domain knowledge that will be needed repeatedly and is not obvious from the code — a pricing rule, a compliance constraint, an external system's quirks |
| `.claude/commands/` | add a command the second time I ask for the same sequence |
| `.mcp.json` | add a server this app's agents will reach for **weekly**. Name it for what it reaches, never for the vendor. Never inline a secret — `${VAR}`, and the var lands in `.env.example` in the same change |
| `docs/gotchas.md` | seed it with anything that already cost us time |

State what you changed and why. If the base already fits, say that instead of editing it for the
sake of editing — a diff that changes nothing is worse than no diff.

## 5. Prepare the boilerplate — do not implement it

**`/idea` prepares for work; it does not do the work.** Generate the shape, leave the behaviour to
`/feature`. Resist the pull to start writing logic — a half-built feature is harder to plan around
than an honest stub.

- Run the generators for what the spec named: `x g resource|entity|action|query|job|route|task`.
  They emit the primitive, its test scaffold, and merge the i18n keys. Never hand-write a file a
  generator owns.
- Leave each handler as the generated stub. Do **not** fill in business logic here.
- `x db gen "<message>"` for the entities, then `x db migrate`.
- `bin/check`. The generated shape must be green before anyone builds on it.

## Report

- Which seed you got, and how you read it.
- The spec path, and the primitive table.
- What you changed in `.claude/`, `CLAUDE.md` and `.mcp.json`, and why.
- What you generated, and what is deliberately still a stub.
- **The questions I still owe you an answer to.** Do not quietly pick a default for something I can
  answer in one line.
- Anything I asked for that does not fit the eight primitives.

Then: `/planx <the first slice>` to plan it, and `/feature` to ship it.
